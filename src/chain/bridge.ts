/**
 * Chain bridge: the pure, offline-testable half of real-money mode.
 *
 *   - id mapping: Holdwork contract id  ->  bytes32 on-chain id
 *   - transaction builders: what an agent signs to open / commit / accept / dispute, plus the USDC approval
 *   - settlement encoding: the arbiter's exact split, derived from an engine Settlement
 *   - event application: given decoded contract events, which engine transitions to run
 *
 * Nothing here talks to a network. The Worker's indexer and the arbiter signer are thin wrappers around it.
 */
import { decodeEventLog, encodeFunctionData, keccak256, toHex, type Address, type Hex, type Log } from 'viem';
import { HOLDWORK_ESCROW_ABI, ERC20_ABI } from './escrow-abi.js';
import type { Contract, Settlement } from '../core/index.js';

export interface ChainConfig {
  chainId: number;
  escrow: Address;
  usdc: Address;
}

export interface PreparedTx {
  to: Address;
  data: Hex;
  value: '0';
  chainId: number;
  description: string;
}

/** Deterministic on-chain id for a Holdwork contract. */
export function onchainId(contractId: string): Hex {
  return keccak256(toHex(`holdwork:v1:${contractId}`));
}

const sec = (ms: number) => BigInt(Math.floor(ms / 1000));

/** USDC approval the agent signs once (or per amount) before open / commit / dispute. */
export function prepareApprove(cfg: ChainConfig, amount: bigint): PreparedTx {
  return {
    to: cfg.usdc, chainId: cfg.chainId, value: '0',
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [cfg.escrow, amount] }),
    description: `Approve the Holdwork escrow to pull up to ${amount} micro-USDC`,
  };
}

/** Buyer locks the price. Requires prior approval of at least `price`. */
export function prepareOpen(cfg: ChainConfig, c: Contract): PreparedTx {
  return {
    to: cfg.escrow, chainId: cfg.chainId, value: '0',
    data: encodeFunctionData({ abi: HOLDWORK_ESCROW_ABI, functionName: 'open', args: [onchainId(c.id), c.price, sec(c.offerDeadline)] }),
    description: `Lock ${c.price} micro-USDC for task ${c.id}; refundable by anyone after ${new Date(c.offerDeadline).toISOString()} if no seller commits`,
  };
}

/** Seller commits and locks the stake. Requires prior approval of at least `stake`. */
export function prepareCommit(cfg: ChainConfig, c: Contract, now: number): PreparedTx {
  return {
    to: cfg.escrow, chainId: cfg.chainId, value: '0',
    data: encodeFunctionData({ abi: HOLDWORK_ESCROW_ABI, functionName: 'commit', args: [onchainId(c.id), c.stake, sec(now + c.deliveryWindowMs)] }),
    description: `Commit to task ${c.id} with a ${c.stake} micro-USDC stake; deliver within ${c.deliveryWindowMs / 3600_000} hours`,
  };
}

/** Buyer releases `toSeller` of the price. Holdwork computes it from the quality claim; the buyer signs it. */
export function prepareAccept(cfg: ChainConfig, c: Contract, toSeller: bigint): PreparedTx {
  return {
    to: cfg.escrow, chainId: cfg.chainId, value: '0',
    data: encodeFunctionData({ abi: HOLDWORK_ESCROW_ABI, functionName: 'accept', args: [onchainId(c.id), toSeller] }),
    description: `Release ${toSeller} of ${c.price} micro-USDC to the seller for task ${c.id}; the rest returns to you`,
  };
}

/** Buyer posts the dispute bond. Requires prior approval of at least `bond`. */
export function prepareDispute(cfg: ChainConfig, c: Contract): PreparedTx {
  return {
    to: cfg.escrow, chainId: cfg.chainId, value: '0',
    data: encodeFunctionData({ abi: HOLDWORK_ESCROW_ABI, functionName: 'dispute', args: [onchainId(c.id), c.bond] }),
    description: `Dispute task ${c.id} with a ${c.bond} micro-USDC bond; three verifiers decide the split`,
  };
}

/** Anyone may call these after the relevant deadline. */
export function prepareRefundUnfilled(cfg: ChainConfig, c: Contract): PreparedTx {
  return { to: cfg.escrow, chainId: cfg.chainId, value: '0', data: encodeFunctionData({ abi: HOLDWORK_ESCROW_ABI, functionName: 'refundUnfilled', args: [onchainId(c.id)] }), description: `Refund unfilled task ${c.id}` };
}
export function prepareRefundMissedDelivery(cfg: ChainConfig, c: Contract): PreparedTx {
  return { to: cfg.escrow, chainId: cfg.chainId, value: '0', data: encodeFunctionData({ abi: HOLDWORK_ESCROW_ABI, functionName: 'refundMissedDelivery', args: [onchainId(c.id)] }), description: `Refund missed delivery on task ${c.id}, stake to buyer` };
}

/**
 * The arbiter's settlement split, derived from an engine settlement of a disputed or silent-buyer
 * contract. Every leg must sum exactly to what the contract holds; the contract enforces it too.
 * Verifier fees the engine took from stake or bond are routed to the fee account on-chain and paid
 * out to verifiers off-chain from there.
 */
export function settlementSplit(c: Contract, s: Settlement) {
  const stakeToFee = s.verifierFeesPaidBy === 'SELLER_STAKE' ? s.verifierFeesPaid : 0n;
  const stakeToSeller = c.stake - stakeToFee; // stake is never forfeited to the buyer at settlement, only at missed delivery
  const bondToFee = s.bondForfeited;
  const bondToBuyer = c.bond - bondToFee;
  const split = {
    toSeller: s.sellerNet, fee: s.fee, refund: s.refund,
    stakeToSeller, stakeToBuyer: 0n, stakeToFee,
    bondToBuyer: s.bondForfeited > 0n ? 0n : bondToBuyer, bondToFee: s.bondForfeited > 0n ? c.bond : 0n,
  };
  if (split.toSeller + split.fee + split.refund !== c.price) throw new Error('price split does not sum');
  if (split.stakeToSeller + split.stakeToBuyer + split.stakeToFee !== c.stake) throw new Error('stake split does not sum');
  const bondHeld = s.bondForfeited > 0n || s.bondReturned > 0n ? c.bond : 0n;
  if (split.bondToBuyer + split.bondToFee !== bondHeld) throw new Error('bond split does not sum');
  return split;
}

export function prepareSettle(cfg: ChainConfig, c: Contract, s: Settlement): PreparedTx {
  const x = settlementSplit(c, s);
  return {
    to: cfg.escrow, chainId: cfg.chainId, value: '0',
    data: encodeFunctionData({
      abi: HOLDWORK_ESCROW_ABI, functionName: 'settle',
      args: [onchainId(c.id), x.toSeller, x.fee, x.refund, x.stakeToSeller, x.stakeToBuyer, x.stakeToFee, x.bondToBuyer, x.bondToFee],
    }),
    description: `Arbiter settlement of ${c.id} at quality ${s.quality}`,
  };
}

// ───────── events ─────────

export type EscrowEvent =
  | { name: 'Opened'; id: Hex; buyer: Address; price: bigint; offerDeadline: bigint }
  | { name: 'Committed'; id: Hex; seller: Address; stake: bigint; deliveryDeadline: bigint }
  | { name: 'Accepted'; id: Hex; toSeller: bigint; fee: bigint; refund: bigint }
  | { name: 'Disputed'; id: Hex; bond: bigint }
  | { name: 'Settled'; id: Hex; toSeller: bigint; fee: bigint; refund: bigint }
  | { name: 'Refunded'; id: Hex; toBuyer: bigint; stakeToBuyer: bigint };

/** Decode a raw log from the escrow contract. Returns null for logs of other contracts or unknown events. */
export function decodeEscrowLog(log: Pick<Log, 'data' | 'topics'>): EscrowEvent | null {
  try {
    const d = decodeEventLog({ abi: HOLDWORK_ESCROW_ABI, data: log.data, topics: log.topics });
    const a = d.args as Record<string, unknown>;
    switch (d.eventName) {
      case 'Opened': return { name: 'Opened', id: a.id as Hex, buyer: a.buyer as Address, price: a.price as bigint, offerDeadline: a.offerDeadline as bigint };
      case 'Committed': return { name: 'Committed', id: a.id as Hex, seller: a.seller as Address, stake: a.stake as bigint, deliveryDeadline: a.deliveryDeadline as bigint };
      case 'Accepted': return { name: 'Accepted', id: a.id as Hex, toSeller: a.toSeller as bigint, fee: a.fee as bigint, refund: a.refund as bigint };
      case 'Disputed': return { name: 'Disputed', id: a.id as Hex, bond: a.bond as bigint };
      case 'Settled': return { name: 'Settled', id: a.id as Hex, toSeller: a.toSeller as bigint, fee: a.fee as bigint, refund: a.refund as bigint };
      case 'Refunded': return { name: 'Refunded', id: a.id as Hex, toBuyer: a.toBuyer as bigint, stakeToBuyer: a.stakeToBuyer as bigint };
      default: return null;
    }
  } catch {
    return null;
  }
}
