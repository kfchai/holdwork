import { describe, it, expect } from 'vitest';
import { HoldworkEngine, usdc, canonicalHash, canonicalJson, type ComputeReport } from '../src/core/index.js';

const compute: ComputeReport = { model: 'x', inputTokens: 1, outputTokens: 1, durationMs: 1, toolCalls: 0, measurement: 'SELF_REPORTED' };

describe('canonical hashing', () => {
  it('is independent of key order and handles bigint', () => {
    expect(canonicalJson({ b: 1n, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":"1"}');
    expect(canonicalHash({ x: 1, y: 2 })).toBe(canonicalHash({ y: 2, x: 1 }));
    expect(canonicalHash({ x: 1 })).not.toBe(canonicalHash({ x: 2 }));
    expect(canonicalHash({})).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('criteria and evidence hashes', () => {
  function setup() {
    const eng = new HoldworkEngine({ networkKey: 'k', now: () => 1_700_000_000_000 });
    eng.registerAgent({ id: 'buyer', operatorId: 'acme', name: 'b' });
    eng.registerAgent({ id: 'seller', operatorId: 'vendor', name: 's' });
    eng.faucet('buyer', usdc(100));
    eng.faucet('seller', usdc(10));
    return eng;
  }

  it('freezes the terms at creation and carries both hashes on the receipt', () => {
    const eng = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(10), acceptanceCriteria: 'three items', outputSchema: { type: 'object' } });
    const frozen = c.criteriaHash;
    expect(frozen).toMatch(/^0x[0-9a-f]{64}$/);
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', { items: 3 }, compute);
    eng.requestRevision(c.id, 'buyer', 0.6, ['add citations']);
    eng.deliver(c.id, 'seller', { items: 3, citations: 2 }, compute);
    eng.accept(c.id, 'buyer', 0.9);
    const s = eng.contract(c.id).settlement!;
    expect(c.criteriaHash).toBe(frozen); // revisions did not touch the terms
    expect(s.criteriaHash).toBe(frozen);
    expect(s.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
    // evidence is the judged delivery, the redelivery, so it differs from a hash of the first one
    const firstDelivery = canonicalHash({ v: 1, contractId: c.id, criteriaHash: frozen, round: 1, output: { items: 3 }, compute, deliveredAt: 1_700_000_000_000 });
    expect(s.evidenceHash).not.toBe(firstDelivery);
    const secondDelivery = canonicalHash({ v: 1, contractId: c.id, criteriaHash: frozen, round: 2, output: { items: 3, citations: 2 }, compute, deliveredAt: 1_700_000_000_000 });
    expect(s.evidenceHash).toBe(secondDelivery);
  });

  it('different terms give different criteria hashes; identical terms on different contracts still differ by id', () => {
    const eng = setup();
    const a = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(1) });
    const b = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(1) });
    const d = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd2', category: 'c', price: usdc(1) });
    expect(a.criteriaHash).not.toBe(b.criteriaHash);
    expect(a.criteriaHash).not.toBe(d.criteriaHash);
  });
});
