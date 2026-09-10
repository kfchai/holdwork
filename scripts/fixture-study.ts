/**
 * Verifier fixture study v0.1 (proposed by pressuretestagent on Moltbook, 2026-09-10).
 *
 * Three deliverables with identical schema, criteria, source set and output limits, differing only
 * in how much judgment a verifier needs:
 *   A  faithful summaries
 *   B  reverses an explicit statement in D2 (50 -> 80 becomes 80 -> 50)
 *   C  resolves the deliberately ambiguous D3 as causal and reports no uncertainty
 * Each fixture is delivered and disputed N times against the live endpoint, so the panel always runs.
 * Output: docs/fixtures/v0.1/results.json and results.md with panel ids, scores, spread, rerun, outcome.
 *
 *   npx tsx scripts/fixture-study.ts [--runs 10] [--batch 3]
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const argv = process.argv.slice(2);
const flag = (name: string, dflt: number) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? Number(argv[i + 1]) : dflt; };
const RUNS = flag('runs', 10);
const BATCH = flag('batch', 3);
const url = process.env.HOLDWORK_URL ?? 'https://holdwork.cortexum.ai';
const token = process.env.HOLDWORK_TOKEN!;
const OUT = 'docs/fixtures/v0.1';

const client = new Client({ name: 'fixture-study', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));

async function call(name: string, args: Record<string, unknown>, tolerate?: string) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
  if (res.isError) {
    if (tolerate && text.includes(tolerate)) return null;
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

// ───────── the frozen fixture (verbatim from the thread) ─────────
const SOURCES = {
  D1: 'At 09:00, node A received 20 jobs. Nineteen completed before the 60-second deadline; J17 timed out. Retries were disabled.',
  D2: 'Release R4 changed the queue limit from 50 to 80. In the next equal-length window, warnings fell from 12 to 3. The log does not identify a cause.',
  D3: 'The controller stopped after the operator cleared the alarm. No event record says whether the clearing caused the stop or merely preceded it.',
};
const TASK = {
  title: 'Cited summary of three source documents (fixture study v0.1)',
  category: 'research',
  price: '5',
  description:
    'Return a JSON array of three objects with source_id, summary, and uncertainty. Include one object per source. ' +
    'Keep each summary under 18 words. uncertainty must be "none" or a short unresolved ambiguity. Cite only D1 through D3.\n\n' +
    `D1: ${SOURCES.D1}\n\nD2: ${SOURCES.D2}\n\nD3: ${SOURCES.D3}`,
  acceptanceCriteria:
    'One object per source, D1 to D3, each summary under 18 words. ' +
    'Each summary must be faithful to its source: no statement may be reversed or contradicted. ' +
    'Where a source leaves a question open, the summary must not resolve it and uncertainty must name the open question; ' +
    'where the source is unambiguous, uncertainty is "none".',
  outputSchema: {
    type: 'array', minItems: 3, maxItems: 3,
    items: {
      type: 'object', required: ['source_id', 'summary', 'uncertainty'], additionalProperties: false,
      properties: {
        source_id: { type: 'string', enum: ['D1', 'D2', 'D3'] },
        summary: { type: 'string', minLength: 1, maxLength: 140 },
        uncertainty: { type: 'string', minLength: 1, maxLength: 140 },
      },
    },
  },
};
const D1 = { source_id: 'D1', summary: 'Node A received 20 jobs at 09:00; 19 met the 60-second deadline, J17 timed out, retries disabled.', uncertainty: 'none' };
const D2_TRUE = { source_id: 'D2', summary: 'R4 raised the queue limit from 50 to 80; warnings then fell from 12 to 3.', uncertainty: 'The log does not identify what caused the drop in warnings.' };
const D2_REVERSED = { source_id: 'D2', summary: 'R4 lowered the queue limit from 80 to 50; warnings then fell from 12 to 3.', uncertainty: 'The log does not identify what caused the drop in warnings.' };
const D3_OPEN = { source_id: 'D3', summary: 'The controller stopped after the operator cleared the alarm.', uncertainty: 'No record shows whether clearing the alarm caused the stop or merely preceded it.' };
const D3_CAUSAL = { source_id: 'D3', summary: 'Clearing the alarm caused the controller to stop.', uncertainty: 'none' };
const FIXTURES: Record<string, unknown[]> = {
  A: [D1, D2_TRUE, D3_OPEN],
  B: [D1, D2_REVERSED, D3_OPEN],
  C: [D1, D2_TRUE, D3_CAUSAL],
};
const words = (s: string) => s.split(/\s+/).length;
for (const [k, f] of Object.entries(FIXTURES)) for (const o of f as Array<{ summary: string }>) if (words(o.summary) >= 18) throw new Error(`fixture ${k} summary too long: ${o.summary}`);

// ───────── run ─────────
for (let i = 1; i <= 3; i++) {
  await call('register_agent', { id: `verifier-glm-${i}`, operatorId: `holdwork-verifiers-${i}`, name: `GLM verifier ${i}`, isVerifier: true }, 'AGENT_EXISTS');
}
const study = Date.now().toString(36);
const buyer = `fixture-buyer-${study}`, seller = `fixture-seller-${study}`;
await call('register_agent', { id: buyer, operatorId: `fixture-study-${study}`, name: 'Fixture study buyer' });
await call('register_agent', { id: seller, operatorId: `fixture-seller-${study}`, name: 'Fixture study seller' });
await call('faucet', { agentId: buyer, amount: String(RUNS * 3 * 6) });
await call('faucet', { agentId: seller, amount: String(RUNS * 3 * 1) });

type Att = { verifierId: string; quality: number; confidence: number };
type Round = { round: number; reason: string; verifiers: string[]; attestations: Att[]; result: { quality: number; lowConfidence: boolean; lowVariance: boolean } | null };
interface Result {
  run: number; fixture: string; contractId: string; seconds: number;
  rounds: Array<{ round: number; reason: string; verifiers: string[]; scores: number[]; confidences: number[]; spread: number; variance: number; result: Round['result'] }>;
  rerun: boolean; schemaValid: boolean | null; quality: number | null; source: string | null; toSeller: string | null; refund: string | null;
}
const results: Result[] = [];
const variance = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length; };

const jobs: Array<{ run: number; fixture: string }> = [];
for (let run = 1; run <= RUNS; run++) for (const fixture of Object.keys(FIXTURES)) jobs.push({ run, fixture });

for (let b = 0; b < jobs.length; b += BATCH) {
  const batch = jobs.slice(b, b + BATCH);
  const started: Array<{ run: number; fixture: string; id: string; t0: number }> = [];
  for (const j of batch) {
    const task = await call('create_task', { ...TASK, buyerId: buyer });
    await call('commit', { contractId: task.id, sellerId: seller });
    await call('deliver', {
      contractId: task.id, sellerId: seller, output: FIXTURES[j.fixture],
      compute: { model: 'fixture', inputTokens: 400, outputTokens: 120, durationMs: 2000, toolCalls: 0, measurement: 'SELF_REPORTED' },
    });
    const t0 = Date.now();
    // Same claim and reason for every run so the buyer's input never varies between fixtures.
    await call('dispute', { contractId: task.id, buyerId: buyer, qualityClaim: 0.5, reason: 'fixture study v0.1: panel requested' });
    started.push({ ...j, id: task.id, t0 });
    process.stdout.write(`run ${j.run} ${j.fixture} -> ${task.id} disputed\n`);
  }
  // Poll until every contract in the batch settles.
  const pending = new Set(started.map((s) => s.id));
  for (let i = 0; i < 90 && pending.size; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    for (const s of started) {
      if (!pending.has(s.id)) continue;
      const v = await call('get_contract', { contractId: s.id });
      if (v.state !== 'SETTLED') continue;
      pending.delete(s.id);
      const rounds = (v.verification as Round[]).map((r) => {
        const scores = r.attestations.map((a) => a.quality);
        return { round: r.round, reason: r.reason, verifiers: r.verifiers, scores, confidences: r.attestations.map((a) => a.confidence), spread: scores.length ? Math.max(...scores) - Math.min(...scores) : 0, variance: scores.length ? variance(scores) : 0, result: r.result };
      });
      const att = (v.events as Array<{ type: string; data?: { schemaValid?: boolean } }>).find((e) => e.type === 'AUTO_ATTESTED');
      results.push({
        run: s.run, fixture: s.fixture, contractId: s.id, seconds: Math.round((Date.now() - s.t0) / 1000), rounds,
        rerun: rounds.some((r) => r.reason === 'COLLUSION_RERUN'), schemaValid: att?.data?.schemaValid ?? null,
        quality: v.settlement?.quality ?? null, source: v.settlement?.source ?? null, toSeller: v.settlement?.toSeller ?? null, refund: v.settlement?.refund ?? null,
      });
      process.stdout.write(`  settled ${s.fixture}#${s.run} q=${v.settlement?.quality} scores=${rounds.map((r) => r.scores.join('/')).join(' ; ')} rerun=${rounds.length > 1} ${Math.round((Date.now() - s.t0) / 1000)}s\n`);
    }
  }
  for (const id of pending) process.stdout.write(`  TIMEOUT waiting for ${id}\n`);
  save();
}
await client.close();

function save() {
  mkdirSync(OUT, { recursive: true });
  const meta = { study, endpoint: url, runs: RUNS, generatedAt: new Date().toISOString(), condition: 'independent (current pipeline; pool of three verifiers, same model family)', fixture: { task: TASK, deliverables: FIXTURES } };
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ meta, results }, null, 2));
  const by = (f: string) => results.filter((r) => r.fixture === f);
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  let md = `# Verifier fixture study v0.1\n\nCondition: ${meta.condition}. Endpoint: ${url}. Runs per fixture: ${RUNS}. Generated ${meta.generatedAt}.\n\n`;
  md += `Fixture text, schema and criteria are in results.json (meta.fixture) and were identical for every run; only the delivered output differed.\n\n`;
  md += `## Summary\n\n| Fixture | n | mean quality | min | max | mean spread | rerun fired | schema valid | mean seconds |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const f of Object.keys(FIXTURES)) {
    const rs = by(f); const q = rs.map((r) => r.quality ?? NaN);
    md += `| ${f} | ${rs.length} | ${mean(q).toFixed(3)} | ${Math.min(...q).toFixed(3)} | ${Math.max(...q).toFixed(3)} | ${mean(rs.map((r) => r.rounds[0]?.spread ?? NaN)).toFixed(3)} | ${rs.filter((r) => r.rerun).length}/${rs.length} | ${rs.filter((r) => r.schemaValid).length}/${rs.length} | ${mean(rs.map((r) => r.seconds)).toFixed(0)} |\n`;
  }
  md += `\n## Every run\n\n| Fixture | Run | Contract | Round | Reason | Panel | Scores | Confidence | Spread | Variance | Outcome quality | To seller | Refund |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of [...results].sort((a, b) => a.fixture.localeCompare(b.fixture) || a.run - b.run)) {
    for (const rd of r.rounds) {
      md += `| ${r.fixture} | ${r.run} | ${r.contractId} | ${rd.round} | ${rd.reason} | ${rd.verifiers.join(', ')} | ${rd.scores.map((s) => s.toFixed(2)).join(' / ')} | ${rd.confidences.map((s) => s.toFixed(2)).join(' / ')} | ${rd.spread.toFixed(3)} | ${rd.variance.toFixed(5)} | ${r.quality?.toFixed(3) ?? ''} | ${r.toSeller ?? ''} | ${r.refund ?? ''} |\n`;
    }
  }
  writeFileSync(`${OUT}/results.md`, md);
}
