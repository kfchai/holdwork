import { describe, it, expect } from 'vitest';
import { HoldworkEngine, usdc, FEE_ACCOUNT, type ComputeReport } from '../src/core/index.js';
import { ChainOps, onchainId, type ChainConfig } from '../src/chain/index.js';

const cfg: ChainConfig = { chainId: 84532, escrow: '0x1111111111111111111111111111111111111111', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };
const compute: ComputeReport = { model: 'x', inputTokens: 1, outputTokens: 1, durationMs: 1, toolCalls: 0, measurement: 'SELF_REPORTED' };
const BUYER_W = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SELLER_W = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function setup() {
  let t = 1_700_000_000_000;
  const eng = new HoldworkEngine({ networkKey: 'k', now: () => t });
  eng.registerAgent({ id: 'buyer', operatorId: 'acme', name: 'b', wallet: BUYER_W });
  eng.registerAgent({ id: 'seller', operatorId: 'vendor', name: 's', wallet: SELLER_W });
  for (let i = 1; i <= 3; i++) eng.registerAgent({ id: `v${i}`, operatorId: `vco${i}`, name: 'v', isVerifier: true });
  const ops = new ChainOps(eng, cfg);
  return { eng, ops, advance: (ms: number) => { t += ms; eng.tick(); } };
}

describe('chain mode: happy path driven by events', () => {
  it('prepare open → Opened funds it → Committed → deliver → prepare accept → Accepted settles the mirror', () => {
    const { eng, ops } = setup();
    const prep = ops.prepareOpen({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(20) });
    const c = prep.contract;
    expect(c.state).toBe('AWAITING_FUNDING');
    expect(eng.listOpenTasks()).toHaveLength(0); // not visible to sellers until funded
    expect(prep.transactions.map((t) => t.to)).toEqual([cfg.usdc, cfg.escrow]);
    expect(eng.ledger.total()).toBe(0n); // nothing in the mirror yet

    expect(ops.applyEvent({ name: 'Opened', id: onchainId(c.id), buyer: BUYER_W, price: usdc(20), offerDeadline: 0n }, '0xtx1')).toMatch(/funded/);
    expect(eng.contract(c.id).state).toBe('OPEN');
    expect(eng.ledger.total()).toBe(usdc(20));
    expect(ops.applyEvent({ name: 'Opened', id: onchainId(c.id), buyer: BUYER_W, price: usdc(20), offerDeadline: 0n }, '0xtx1')).toBeNull(); // replay is idempotent

    ops.prepareCommit(c.id, 'seller');
    expect(ops.applyEvent({ name: 'Committed', id: onchainId(c.id), seller: SELLER_W, stake: usdc(1), deliveryDeadline: 0n }, '0xtx2')).toMatch(/committed/);
    expect(eng.contract(c.id).state).toBe('COMMITTED');

    eng.deliver(c.id, 'seller', { ok: true }, compute);
    const acc = ops.prepareAccept(c.id, 'buyer', 0.6); // half quality → half price
    expect(acc.toSeller).toBe(usdc(10));
    expect(eng.contract(c.id).pendingClaim?.kind).toBe('ACCEPT');

    // Buyer signs a different amount than prepared: refused, nothing moves.
    expect(() => ops.applyEvent({ name: 'Accepted', id: onchainId(c.id), toSeller: usdc(20), fee: 0n, refund: 0n }, '0xbad')).toThrow(/PAYOUT_MISMATCH|released/);
    expect(eng.contract(c.id).state).toBe('DELIVERED');

    expect(ops.applyEvent({ name: 'Accepted', id: onchainId(c.id), toSeller: usdc(10), fee: usdc('0.10'), refund: usdc(10) }, '0xtx3')).toMatch(/accepted/);
    const s = eng.contract(c.id).settlement!;
    expect(s.qualitySource).toBe('BUYER_CLAIM');
    expect(s.toSeller).toBe(usdc(10));
    expect(eng.balance('seller')).toBe(usdc(10) - usdc('0.10') + usdc(1)); // share less fee, stake back
    expect(eng.balance('buyer')).toBe(usdc(10));
    expect(eng.balance(FEE_ACCOUNT)).toBe(usdc('0.10'));
    expect(ops.pendingArbiterActions()).toHaveLength(0); // buyer-signed release needs no arbiter
  });
});

describe('chain mode: dispute produces exactly one arbiter settlement', () => {
  it('Disputed applies the prepared claim; consensus settles; the arbiter action carries an exact split', () => {
    const { eng, ops } = setup();
    const c = ops.prepareOpen({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(20) }).contract;
    ops.applyEvent({ name: 'Opened', id: onchainId(c.id), buyer: BUYER_W, price: usdc(20), offerDeadline: 0n }, '0x1');
    ops.applyEvent({ name: 'Committed', id: onchainId(c.id), seller: SELLER_W, stake: usdc(1), deliveryDeadline: 0n }, '0x2');
    eng.deliver(c.id, 'seller', {}, compute);
    ops.prepareDispute(c.id, 'buyer', 0.3, 'incomplete');
    ops.applyEvent({ name: 'Disputed', id: onchainId(c.id), bond: usdc(2) }, '0x3');
    expect(eng.contract(c.id).state).toBe('VERIFYING');
    expect(ops.pendingArbiterActions()).toHaveLength(0); // not settled yet

    const [a, b, d] = eng.contract(c.id).verification[0].verifierIds;
    eng.attest(c.id, a, 0.35, 0.9); eng.attest(c.id, b, 0.45, 0.9); eng.attest(c.id, d, 0.50, 0.9);
    expect(eng.contract(c.id).state).toBe('SETTLED');

    const actions = ops.pendingArbiterActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('settle');
    expect(actions[0].tx.to).toBe(cfg.escrow);
    ops.markSubmitted(c.id, 'settle', '0xsettle');
    expect(ops.pendingArbiterActions()).toHaveLength(0);
    ops.applyEvent({ name: 'Settled', id: onchainId(c.id), toSeller: 0n, fee: 0n, refund: 0n }, '0xsettle');
    expect(eng.contract(c.id).chain?.settled).toBe('0xsettle');
  });
});

describe('chain mode: guards and timeouts', () => {
  it('refuses events from the wrong wallet or with the wrong amounts', () => {
    const { ops } = setup();
    const c = ops.prepareOpen({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(20) }).contract;
    expect(() => ops.applyEvent({ name: 'Opened', id: onchainId(c.id), buyer: SELLER_W, price: usdc(20), offerDeadline: 0n }, '0x')).toThrow(/WALLET_MISMATCH|not the task/);
    expect(() => ops.applyEvent({ name: 'Opened', id: onchainId(c.id), buyer: BUYER_W, price: usdc(19), offerDeadline: 0n }, '0x')).toThrow(/FUNDING_MISMATCH|price/);
    ops.applyEvent({ name: 'Opened', id: onchainId(c.id), buyer: BUYER_W, price: usdc(20), offerDeadline: 0n }, '0x1');
    expect(() => ops.applyEvent({ name: 'Committed', id: onchainId(c.id), seller: SELLER_W, stake: usdc('0.5'), deliveryDeadline: 0n }, '0x')).toThrow(/Staked .* requires/);
  });

  it('requires a wallet to prepare anything, and ignores events for unknown ids', () => {
    const { eng, ops } = setup();
    eng.registerAgent({ id: 'nowallet', operatorId: 'x', name: 'n' });
    expect(() => ops.prepareOpen({ buyerId: 'nowallet', title: 't', description: 'd', category: 'c', price: usdc(1) })).toThrow(/NO_WALLET|no wallet/);
    expect(ops.applyEvent({ name: 'Opened', id: '0x' + 'ff'.repeat(32) as `0x${string}`, buyer: BUYER_W, price: 1n, offerDeadline: 0n }, '0x')).toBeNull();
  });

  it('unfunded offers cancel at the deadline with nothing moved; funded unfilled offers owe a refund tx', () => {
    const { eng, ops, advance } = setup();
    const a = ops.prepareOpen({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(5), offerWindowMs: 3600_000 }).contract;
    const b = ops.prepareOpen({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(5), offerWindowMs: 3600_000 }).contract;
    ops.applyEvent({ name: 'Opened', id: onchainId(b.id), buyer: BUYER_W, price: usdc(5), offerDeadline: 0n }, '0xb');
    advance(3600_001);
    expect(eng.contract(a.id).state).toBe('CANCELLED');
    expect(eng.contract(b.id).state).toBe('CANCELLED');
    const actions = ops.pendingArbiterActions();
    expect(actions.map((x) => [x.contractId, x.action])).toEqual([[b.id, 'refundUnfilled']]); // only the funded one
    expect(eng.ledger.total()).toBe(usdc(5)); // mirror: b's price back to buyer, a never had anything
  });
});
