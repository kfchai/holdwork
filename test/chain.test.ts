import { describe, it, expect } from 'vitest';
import { decodeFunctionData, encodeEventTopics, encodeAbiParameters, type Hex } from 'viem';
import { HoldworkEngine, usdc, type ComputeReport } from '../src/core/index.js';
import { HOLDWORK_ESCROW_ABI, onchainId, prepareOpen, prepareCommit, prepareAccept, prepareDispute, prepareApprove, prepareSettle, settlementSplit, decodeEscrowLog, type ChainConfig } from '../src/chain/index.js';

const cfg: ChainConfig = { chainId: 84532, escrow: '0x1111111111111111111111111111111111111111', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };
const compute: ComputeReport = { model: 'x', inputTokens: 1, outputTokens: 1, durationMs: 1, toolCalls: 0, measurement: 'SELF_REPORTED' };

function setup() {
  let t = 1_700_000_000_000;
  const eng = new HoldworkEngine({ networkKey: 'k', now: () => t });
  eng.registerAgent({ id: 'buyer', operatorId: 'acme', name: 'b' });
  eng.registerAgent({ id: 'seller', operatorId: 'vendor', name: 's' });
  for (let i = 1; i <= 3; i++) eng.registerAgent({ id: `v${i}`, operatorId: `vco${i}`, name: 'v', isVerifier: true });
  eng.faucet('buyer', usdc(100));
  eng.faucet('seller', usdc(10));
  return { eng, advance: (ms: number) => { t += ms; } };
}

describe('chain bridge: ids and calldata', () => {
  it('maps contract ids deterministically to bytes32', () => {
    expect(onchainId('hw_abc')).toBe(onchainId('hw_abc'));
    expect(onchainId('hw_abc')).not.toBe(onchainId('hw_abd'));
    expect(onchainId('hw_abc')).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('encodes open / commit / accept / dispute / approve with the contract terms', () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(20), offerWindowMs: 3600_000, deliveryWindowMs: 7200_000 });
    const open = decodeFunctionData({ abi: HOLDWORK_ESCROW_ABI, data: prepareOpen(cfg, c).data });
    expect(open.functionName).toBe('open');
    expect(open.args).toEqual([onchainId(c.id), usdc(20), BigInt(Math.floor(c.offerDeadline / 1000))]);

    const commit = decodeFunctionData({ abi: HOLDWORK_ESCROW_ABI, data: prepareCommit(cfg, c, c.createdAt).data });
    expect(commit.args).toEqual([onchainId(c.id), usdc(1), BigInt(Math.floor((c.createdAt + 7200_000) / 1000))]);

    const accept = decodeFunctionData({ abi: HOLDWORK_ESCROW_ABI, data: prepareAccept(cfg, c, usdc(10)).data });
    expect(accept.args).toEqual([onchainId(c.id), usdc(10)]);

    const dispute = decodeFunctionData({ abi: HOLDWORK_ESCROW_ABI, data: prepareDispute(cfg, c).data });
    expect(dispute.args).toEqual([onchainId(c.id), usdc(2)]);

    const approve = prepareApprove(cfg, usdc(20));
    expect(approve.to).toBe(cfg.usdc);
    expect(prepareOpen(cfg, c).to).toBe(cfg.escrow);
  });
});

describe('chain bridge: settlement split', () => {
  it('buyer vindicated: stake pays verifier fees to fee account, bond returned, sums exact', () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(20) });
    eng.commit(c.id, 'seller'); eng.deliver(c.id, 'seller', {}, compute); eng.dispute(c.id, 'buyer', 0.4, 'x');
    const [a, b, d] = eng.contract(c.id).verification[0].verifierIds;
    eng.attest(c.id, a, 0.35, 0.9); eng.attest(c.id, b, 0.45, 0.9); eng.attest(c.id, d, 0.50, 0.9); // spread avoids the collusion rerun
    const s = eng.contract(c.id).settlement!;
    const x = settlementSplit(c, s);
    expect(x.toSeller + x.fee + x.refund).toBe(usdc(20));
    expect(x.stakeToFee).toBe(usdc('0.15'));
    expect(x.stakeToSeller).toBe(usdc('0.85'));
    expect(x.bondToBuyer).toBe(usdc(2));
    expect(x.bondToFee).toBe(0n);
    const tx = decodeFunctionData({ abi: HOLDWORK_ESCROW_ABI, data: prepareSettle(cfg, c, s).data });
    expect(tx.functionName).toBe('settle');
    const args = tx.args as unknown as bigint[];
    expect(args[1] + args[2] + args[3]).toBe(usdc(20));
  });

  it('buyer loses: bond to fee account, stake fully back to seller', () => {
    const { eng } = setup();
    const c = eng.createTask({ buyerId: 'buyer', title: 't', description: 'd', category: 'c', price: usdc(20) });
    eng.commit(c.id, 'seller'); eng.deliver(c.id, 'seller', {}, compute); eng.dispute(c.id, 'buyer', 0.3, 'x');
    const [a, b, d] = eng.contract(c.id).verification[0].verifierIds;
    eng.attest(c.id, a, 0.88, 0.9); eng.attest(c.id, b, 0.93, 0.9); eng.attest(c.id, d, 0.85, 0.9);
    const x = settlementSplit(c, eng.contract(c.id).settlement!);
    expect(x.bondToFee).toBe(usdc(2));
    expect(x.bondToBuyer).toBe(0n);
    expect(x.stakeToSeller).toBe(usdc(1));
    expect(x.stakeToFee).toBe(0n);
    expect(x.toSeller + x.fee).toBe(usdc(20));
  });
});

describe('chain bridge: event decoding', () => {
  it('decodes an Opened log and ignores foreign logs', () => {
    const id = onchainId('hw_x');
    const buyer = '0x2222222222222222222222222222222222222222';
    const topics = encodeEventTopics({ abi: HOLDWORK_ESCROW_ABI, eventName: 'Opened', args: { id, buyer } });
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [usdc(5), 1_700_000_000n]);
    const ev = decodeEscrowLog({ topics: topics as [Hex, ...Hex[]], data });
    expect(ev).toEqual({ name: 'Opened', id, buyer, price: usdc(5), offerDeadline: 1_700_000_000n });
    expect(decodeEscrowLog({ topics: ['0x' + 'ab'.repeat(32) as Hex], data: '0x' })).toBeNull();
  });
});
