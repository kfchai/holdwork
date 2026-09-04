import { describe, it, expect } from 'vitest';
import { HoldworkEngine, usdc, type ComputeReport } from '../src/core/index.js';
import { LocalOps, computeStats } from '../src/mcp/ops.js';

const compute: ComputeReport = { model: 'x', inputTokens: 1, outputTokens: 1, durationMs: 1, toolCalls: 0, measurement: 'SELF_REPORTED' };

describe('LocalOps and stats', () => {
  it('returns typed envelopes and persists via the save hook', async () => {
    let saves = 0;
    const eng = new HoldworkEngine({ networkKey: 'k' });
    const ops = new LocalOps(eng, { save: () => { saves++; } });
    const r = await ops.registerAgent({ operatorId: 'acme', name: 'b', id: 'buyer' });
    expect(r.ok).toBe(true);
    const bad = await ops.faucet({ agentId: 'nobody', amount: '1' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('UNKNOWN_AGENT');
    expect(saves).toBe(1); // failed op did not persist
  });

  it('computes operating metrics from settled and disputed contracts', async () => {
    let t = 1_700_000_000_000;
    const eng = new HoldworkEngine({ networkKey: 'k', now: () => t });
    eng.registerAgent({ id: 'buyer', operatorId: 'acme', name: 'b' });
    eng.registerAgent({ id: 'seller', operatorId: 'vendor', name: 's' });
    for (let i = 1; i <= 3; i++) eng.registerAgent({ id: `v${i}`, operatorId: `vco${i}`, name: 'v', isVerifier: true });
    eng.faucet('buyer', usdc(100));
    eng.faucet('seller', usdc(10));

    const a = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(10) });
    eng.commit(a.id, 'seller'); eng.deliver(a.id, 'seller', {}, compute); eng.accept(a.id, 'buyer', 0.9);

    const b = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(10) });
    eng.commit(b.id, 'seller'); eng.deliver(b.id, 'seller', {}, compute); eng.dispute(b.id, 'buyer', 0.3, 'x');
    t += 90_000;
    const [v1, v2, v3] = eng.contract(b.id).verification[0].verifierIds;
    eng.attest(b.id, v1, 0.3, 0.9); eng.attest(b.id, v2, 0.35, 0.9); eng.attest(b.id, v3, 0.5, 0);

    const s = computeStats(eng);
    expect(s.agents).toBe(5);
    expect(s.verifiers).toBe(3);
    expect(s.settled).toBe(2);
    expect(s.disputes).toBe(1);
    expect(s.disputesBuyerVindicated).toBe(1);
    expect(s.attestations).toBe(3);
    expect(s.zeroConfidenceAttestations).toBe(1);
    expect(s.medianDisputeSettleSeconds).toBe(90);
    expect(s.ledgerTotal).toBe('110');
    expect(s.contractsByState.SETTLED).toBe(2);
  });
});
