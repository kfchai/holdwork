import { describe, it, expect } from 'vitest';
import { HoldworkEngine, usdc, type ComputeReport } from '../src/core/index.js';
import { AutoVerifier, checkSchema, toScoringInput, type Score, type Scorer, type ScoringInput } from '../src/verifier/index.js';

const compute: ComputeReport = { model: 'test', inputTokens: 10, outputTokens: 10, durationMs: 10, toolCalls: 0, measurement: 'SELF_REPORTED' };

/** Deterministic scorer: quality from a lookup by contract title, schema check applied like the real one. */
class FakeScorer implements Scorer {
  readonly name = 'fake';
  seen: ScoringInput[] = [];
  constructor(private readonly quality: number, private readonly confidence = 0.9) {}
  async score(input: ScoringInput): Promise<Score> {
    this.seen.push(input);
    const schema = checkSchema(input.outputSchema, input.output);
    const q = schema.applicable && !schema.valid ? Math.min(this.quality, 0.55) : this.quality;
    return {
      quality: q, confidence: this.confidence, schemaValid: schema.valid, schemaErrors: schema.errors,
      criteriaMet: [], criteriaMissed: [], rationale: 'fake', scorer: this.name,
    };
  }
}

function setup() {
  let t = 1_700_000_000_000;
  const eng = new HoldworkEngine({ networkKey: 'k', now: () => t });
  eng.registerAgent({ id: 'buyer', operatorId: 'acme', name: 'b' });
  eng.registerAgent({ id: 'seller', operatorId: 'vendor', name: 's' });
  for (let i = 1; i <= 3; i++) eng.registerAgent({ id: `v${i}`, operatorId: `vco-${i}`, name: `v${i}`, isVerifier: true });
  eng.faucet('buyer', usdc(100));
  eng.faucet('seller', usdc(10));
  return { eng, advance: (ms: number) => { t += ms; eng.tick(); } };
}

describe('schema check', () => {
  const schema = { type: 'object', required: ['summaries', 'citations'], properties: { summaries: { type: 'integer', minimum: 3 }, citations: { type: 'array', items: { type: 'string' } } } };
  it('passes valid output and fails invalid output with readable errors', () => {
    expect(checkSchema(schema, { summaries: 3, citations: ['p4'] }).valid).toBe(true);
    const bad = checkSchema(schema, { summaries: 1 });
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/citations|minimum/);
  });
  it('is not applicable when no schema was given', () => {
    expect(checkSchema(null, { anything: true })).toEqual({ applicable: false, valid: true, errors: [] });
  });
});

describe('auto verifier', () => {
  it('attests on every assigned round and settles a dispute without a human', async () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(20) });
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', { text: 'ok' }, compute);
    eng.dispute(c.id, 'buyer', 0.3, 'weak');

    const scorer = new FakeScorer(0.85);
    const auto = new AutoVerifier(eng, scorer, ['v1', 'v2', 'v3']);
    expect(auto.pending()).toHaveLength(3);
    const done = await auto.run();

    expect(done).toHaveLength(3);
    expect(scorer.seen).toHaveLength(3); // independent scoring call per verifier
    const settled = eng.contract(c.id);
    // a deterministic fake gives identical scores, which trips the collusion guard: a rerun opens
    // with the same pool (only 3 verifiers exist), so run once more to settle.
    if (settled.state === 'VERIFYING') await auto.run();
    expect(eng.contract(c.id).state).toBe('SETTLED');
    expect(eng.contract(c.id).settlement!.qualitySource).toBe('NETWORK');
    expect(eng.contract(c.id).settlement!.toSeller).toBe(usdc(20));
    expect(auto.pending()).toHaveLength(0);
  });

  it('never exposes the buyer claim to the scorer', async () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(5) });
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', { text: 'ok' }, compute);
    eng.dispute(c.id, 'buyer', 0.11, 'x');
    const scorer = new FakeScorer(0.9);
    await new AutoVerifier(eng, scorer, ['v1']).run();
    const input = scorer.seen[0] as unknown as Record<string, unknown>;
    expect(input).not.toHaveProperty('buyerClaim');
    expect(JSON.stringify(input)).not.toContain('0.11');
  });

  it('caps quality when the output violates the buyer schema', async () => {
    const { eng } = setup();
    const c = eng.createTask({
      buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(10),
      outputSchema: { type: 'object', required: ['summaries'], properties: { summaries: { type: 'integer', minimum: 3 } } },
    });
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', { summaries: 1 }, compute);
    eng.dispute(c.id, 'buyer', 0.2, 'only one summary');
    const scorer = new FakeScorer(0.95);
    const auto = new AutoVerifier(eng, scorer, ['v1', 'v2', 'v3']);
    const done = await auto.run();
    expect(done[0].quality).toBe(0.55);
  });

  it('builds the scoring input from the latest delivery and prior revision issues', () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(10) });
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', { v: 1 }, compute);
    eng.requestRevision(c.id, 'buyer', 0.5, ['fix A']);
    eng.deliver(c.id, 'seller', { v: 2 }, compute);
    const input = toScoringInput(eng.contract(c.id));
    expect(input.output).toEqual({ v: 2 });
    expect(input.revisionIssues).toEqual(['fix A']);
  });
});
