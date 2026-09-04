import { describe, it, expect, beforeEach } from 'vitest';
import { HoldworkEngine, HoldworkError, usdc, fmt, FEE_ACCOUNT, type ComputeReport } from '../src/core/index.js';

const HOUR = 3600_000;
const compute: ComputeReport = {
  model: 'claude-sonnet-5', inputTokens: 1200, outputTokens: 800, durationMs: 4200, toolCalls: 2, measurement: 'RUNTIME_METERED',
};

function setup() {
  let t = 1_700_000_000_000;
  const eng = new HoldworkEngine({ networkKey: 'test-key', now: () => t });
  const advance = (ms: number) => { t += ms; return eng.tick(); };
  const buyer = eng.registerAgent({ id: 'buyer', operatorId: 'acme', name: 'Acme buyer' });
  const seller = eng.registerAgent({ id: 'seller', operatorId: 'vendor', name: 'Vendor seller', skills: ['research'] });
  for (let i = 1; i <= 5; i++) eng.registerAgent({ id: `v${i}`, operatorId: `verifier-co-${i}`, name: `Verifier ${i}`, isVerifier: true });
  eng.faucet('buyer', usdc(100));
  eng.faucet('seller', usdc(10));
  return { eng, advance, buyer, seller, t: () => t };
}

describe('happy path', () => {
  it('locks budget, releases on accept, takes a fee, returns stake', () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 'Summarise 10 filings', description: '...', category: 'research', price: usdc(20) });
    expect(eng.balance('buyer')).toBe(usdc(80));
    expect(c.state).toBe('OPEN');

    eng.commit(c.id, 'seller');
    expect(eng.balance('seller')).toBe(usdc(10) - usdc(1)); // 5% stake of 20 = 1.00
    eng.deliver(c.id, 'seller', { summary: 'done' }, compute);
    eng.accept(c.id, 'buyer', 0.9);

    const s = eng.contract(c.id).settlement!;
    expect(eng.contract(c.id).state).toBe('SETTLED');
    expect(s.toSeller).toBe(usdc(20));
    expect(s.fee).toBe(usdc('0.20'));
    expect(fmt(eng.balance('seller'))).toBe('29.8'); // 10 + 20 - 0.20 fee, stake back
    expect(eng.balance(FEE_ACCOUNT)).toBe(usdc('0.20'));
    expect(eng.balance('buyer')).toBe(usdc(80));
    expect(eng.ledger.total()).toBe(usdc(110)); // money is conserved
  });

  it('pays partially for middling quality and refunds the rest', () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(10) });
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', {}, compute);
    eng.accept(c.id, 'buyer', 0.6); // ratio (0.6-0.4)/0.4 = 0.5
    const s = eng.contract(c.id).settlement!;
    expect(s.toSeller).toBe(usdc(5));
    expect(s.refund).toBe(usdc(5));
    expect(s.fee).toBe(usdc('0.05')); // 1% of 5 = 0.05 = min fee
  });

  it('pays nothing below the zero-pay threshold', () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(10) });
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', {}, compute);
    eng.accept(c.id, 'buyer', 0.2);
    const s = eng.contract(c.id).settlement!;
    expect(s.toSeller).toBe(0n);
    expect(s.fee).toBe(0n);
    expect(eng.balance('buyer')).toBe(usdc(100));
  });
});

describe('guards', () => {
  it('rejects self-dealing at commit', () => {
    const { eng } = setup();
    eng.registerAgent({ id: 'acme-seller', operatorId: 'acme', name: 'same operator' });
    eng.faucet('acme-seller', usdc(5));
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(10) });
    expect(() => eng.commit(c.id, 'acme-seller')).toThrowError(/different operators/);
  });

  it('enforces spend policy before locking any funds', () => {
    const { eng } = setup();
    eng.setSpendPolicy('acme', { maxPerTask: usdc(15), maxPerDay: usdc(25), allowedCategories: ['research'] });
    expect(() => eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(20) }))
      .toThrow(HoldworkError);
    expect(() => eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'design', price: usdc(5) }))
      .toThrowError(/not allowed/);
    eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(15) });
    expect(() => eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(12) }))
      .toThrowError(/max_per_day/);
    expect(eng.balance('buyer')).toBe(usdc(85)); // only the one allowed task locked
  });

  it('rejects a bad compute report', () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(10) });
    eng.commit(c.id, 'seller');
    expect(() => eng.deliver(c.id, 'seller', {}, { ...compute, inputTokens: -1 })).toThrowError(/Compute report/);
  });
});

describe('dispute', () => {
  it('buyer vindicated: seller stake pays verifiers, bond returned, partial payout', () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(20) });
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', {}, compute);
    eng.dispute(c.id, 'buyer', 0.5, 'Half the filings missing');
    const round = eng.contract(c.id).verification[0];
    expect(round.verifierIds).toHaveLength(3);
    expect(eng.balance('buyer')).toBe(usdc(80) - usdc(2)); // bond 10% of 20

    const [a, b, d] = round.verifierIds;
    eng.attest(c.id, a, 0.5, 0.9);
    eng.attest(c.id, b, 0.6, 0.8);
    eng.attest(c.id, d, 0.4, 0.7);

    const done = eng.contract(c.id);
    expect(done.state).toBe('SETTLED');
    const s = done.settlement!;
    expect(s.qualitySource).toBe('NETWORK');
    expect(s.quality).toBeGreaterThan(0.45);
    expect(s.quality).toBeLessThan(0.55);
    expect(s.verifierFeesPaidBy).toBe('SELLER_STAKE');
    expect(s.verifierFeesPaid).toBe(usdc('0.15'));
    expect(s.bondReturned).toBe(usdc(2));
    expect(eng.balance('buyer')).toBe(usdc(80) + s.refund);
    expect(eng.balance(a)).toBe(usdc('0.05'));
    expect(eng.ledger.total()).toBe(usdc(110));
  });

  it('buyer loses: bond pays verifiers and Holdwork, seller paid in full', () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(20) });
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', {}, compute);
    eng.dispute(c.id, 'buyer', 0.3, 'Not good enough');
    const scores = [0.88, 0.93, 0.85];
    eng.contract(c.id).verification[0].verifierIds.forEach((v, i) => eng.attest(c.id, v, scores[i], 0.9));
    const s = eng.contract(c.id).settlement!;
    expect(s.verifierFeesPaidBy).toBe('BUYER_BOND');
    expect(s.bondForfeited).toBe(usdc(2));
    expect(s.toSeller).toBe(usdc(20));
    expect(s.stakeReturned).toBe(usdc(1));
    expect(eng.balance(FEE_ACCOUNT)).toBe(usdc('0.20') + usdc(2) - usdc('0.15'));
    expect(eng.ledger.total()).toBe(usdc(110));
  });

  it('flags suspiciously uniform verifier scores and reruns with fresh verifiers', () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(20) });
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', {}, compute);
    eng.dispute(c.id, 'buyer', 0.3, 'x');
    const r1 = eng.contract(c.id).verification[0];
    for (const v of r1.verifierIds) eng.attest(c.id, v, 0.95, 0.9);
    const after = eng.contract(c.id);
    expect(after.verification).toHaveLength(2);
    expect(after.verification[1].reason).toBe('COLLUSION_RERUN');
    expect(after.state).toBe('VERIFYING');
  });
});

describe('timeouts', () => {
  it('cancels an unfilled offer and refunds', () => {
    const { eng, advance } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(10), offerWindowMs: HOUR });
    advance(2 * HOUR);
    expect(eng.contract(c.id).state).toBe('CANCELLED');
    expect(eng.balance('buyer')).toBe(usdc(100));
  });

  it('expires a missed delivery, refunds buyer, forfeits stake to buyer', () => {
    const { eng, advance } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(10), deliveryWindowMs: HOUR });
    eng.commit(c.id, 'seller');
    advance(2 * HOUR);
    expect(eng.contract(c.id).state).toBe('EXPIRED');
    expect(eng.balance('buyer')).toBe(usdc(100) + usdc('0.50'));
    expect(eng.agent('seller').reputation).toBeCloseTo(0.45);
  });

  it('escalates a silent buyer to verification with no bond', () => {
    const { eng, advance } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(10) });
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', {}, compute);
    advance(25 * HOUR);
    const v = eng.contract(c.id);
    expect(v.state).toBe('VERIFYING');
    expect(v.verification[0].reason).toBe('ASSESSMENT_TIMEOUT');
    const scores = [0.85, 0.9, 0.82];
    v.verification[0].verifierIds.forEach((id, i) => eng.attest(c.id, id, scores[i], 0.8));
    const s = eng.contract(c.id).settlement!;
    expect(s.toSeller).toBe(usdc(10));
    expect(s.verifierFeesPaidBy).toBe('HOLDWORK');
    expect(s.verifierFeesPaid).toBe(0n); // fee account was empty, Holdwork pays only what it has
    expect(eng.ledger.total()).toBe(usdc(110));
  });

  it('auto-disputes when the seller misses a revision deadline', () => {
    const { eng, advance } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(10) });
    eng.commit(c.id, 'seller');
    eng.deliver(c.id, 'seller', {}, compute);
    eng.requestRevision(c.id, 'buyer', 0.55, ['Missing section 3']);
    advance(49 * HOUR);
    const v = eng.contract(c.id);
    expect(v.verification[0].reason).toBe('REVISION_TIMEOUT');
    expect(eng.balance('buyer')).toBe(usdc(90)); // no bond taken
  });
});

describe('sampling and calibration', () => {
  it('sampling is deterministic and close to the configured rate', () => {
    const { eng } = setup();
    let sampled = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      eng.faucet('buyer', usdc(1));
      const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(1) });
      eng.commit(c.id, 'seller');
      eng.deliver(c.id, 'seller', {}, compute);
      eng.accept(c.id, 'buyer', 0.9);
      if (eng.contract(c.id).calibrationSample?.sampled) sampled++;
    }
    expect(sampled).toBeGreaterThan(N * 0.05);
    expect(sampled).toBeLessThan(N * 0.16);
  });

  it('a sampled acceptance updates buyer calibration without moving settled money', () => {
    const { eng } = setup();
    let c;
    do {
      eng.faucet('buyer', usdc(1));
      c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'research', price: usdc(1) });
      eng.commit(c.id, 'seller');
      eng.deliver(c.id, 'seller', {}, compute);
      eng.accept(c.id, 'buyer', 0.95);
    } while (!eng.contract(c.id).calibrationSample?.sampled);

    const sellerBefore = eng.balance('seller');
    const before = eng.agent('buyer').buyer.calibration;
    const scores = [0.45, 0.5, 0.55];
    eng.contract(c.id).verification[0].verifierIds.forEach((v, i) => eng.attest(c.id, v, scores[i], 0.9));
    const done = eng.contract(c.id);
    expect(done.calibrationSample?.completed).toBe(true);
    expect(done.calibrationSample?.delta).toBeCloseTo(0.45, 1);
    expect(eng.agent('buyer').buyer.calibration).toBeLessThan(before);
    expect(eng.agent('buyer').buyer.bias).toBeGreaterThan(0);
    expect(eng.balance('seller')).toBe(sellerBefore); // no clawback
  });
});
