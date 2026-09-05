/**
 * ChainOps: real-money mode on top of the engine.
 *
 * Agents sign their own transactions. This layer
 *   - prepares the exact calldata for open / commit / accept / dispute and records the intent,
 *   - applies decoded escrow events to the engine so state follows the chain,
 *   - lists the arbiter actions still owed to the chain (dispute settlements, permissionless refunds).
 *
 * The engine's ledger is a mirror: every on-chain deposit is credited at the moment its event is
 * applied, so conservation still holds and every existing engine rule keeps working.
 */
import type { Address, Hex } from 'viem';
import { HoldworkEngine, HoldworkError, usdc, type Contract, type Micro } from '../core/index.js';
import {
  onchainId, prepareApprove, prepareOpen, prepareCommit, prepareAccept, prepareDispute, prepareSettle,
  prepareRefundUnfilled, prepareRefundMissedDelivery, type ChainConfig, type EscrowEvent, type PreparedTx,
} from './bridge.js';
import type { CreateTaskInput } from '../core/engine.js';

export interface ArbiterAction {
  contractId: string;
  action: 'settle' | 'refundUnfilled' | 'refundMissedDelivery';
  tx: PreparedTx;
}

export class ChainOps {
  private readonly byOnchainId = new Map<Hex, string>();

  constructor(readonly engine: HoldworkEngine, readonly cfg: ChainConfig) {
    for (const c of engine.contracts.values()) this.byOnchainId.set(onchainId(c.id), c.id);
  }

  private wallet(agentId: string): Address {
    const a = this.engine.agent(agentId);
    if (!a.wallet) throw new HoldworkError('NO_WALLET', `Agent ${agentId} has no wallet registered; re-register with a wallet address`);
    return a.wallet as Address;
  }

  private contractFor(id: Hex): Contract | undefined {
    const cid = this.byOnchainId.get(id);
    return cid ? this.engine.contracts.get(cid) : undefined;
  }

  // ───────── prepare: what the agent signs ─────────

  prepareOpen(input: CreateTaskInput) {
    this.wallet(input.buyerId);
    const c = this.engine.createTask(input, { deferFunding: true });
    this.byOnchainId.set(onchainId(c.id), c.id);
    return { contract: c, onchainId: onchainId(c.id), transactions: [prepareApprove(this.cfg, c.price), prepareOpen(this.cfg, c)] };
  }

  prepareCommit(contractId: string, sellerId: string) {
    this.wallet(sellerId);
    const c = this.engine.contract(contractId);
    if (c.state !== 'OPEN') throw new HoldworkError('BAD_STATE', `Contract is ${c.state}, expected OPEN`);
    if (this.engine.agent(sellerId).operatorId === c.buyerOperatorId) throw new HoldworkError('SELF_DEALING', 'Buyer and seller must belong to different operators');
    return { contract: c, transactions: [prepareApprove(this.cfg, c.stake), prepareCommit(this.cfg, c, this.engine.now())] };
  }

  prepareAccept(contractId: string, buyerId: string, qualityClaim: number) {
    this.wallet(buyerId);
    const c = this.engine.setPendingClaim(contractId, buyerId, 'ACCEPT', qualityClaim);
    return { contract: c, toSeller: c.pendingClaim!.toSeller, transactions: [prepareAccept(this.cfg, c, c.pendingClaim!.toSeller)] };
  }

  prepareDispute(contractId: string, buyerId: string, qualityClaim: number, reason: string) {
    this.wallet(buyerId);
    const c = this.engine.setPendingClaim(contractId, buyerId, 'DISPUTE', qualityClaim, reason);
    return { contract: c, transactions: [prepareApprove(this.cfg, c.bond), prepareDispute(this.cfg, c)] };
  }

  // ───────── apply: what the chain says happened ─────────

  /** Returns a short description of what was applied, or null if the event was not ours or already applied. */
  applyEvent(ev: EscrowEvent, txHash: string): string | null {
    const c = this.contractFor(ev.id);
    if (!c) return null;
    c.chain ??= {};
    const key = ev.name.toLowerCase();
    if (c.chain[key] === txHash) return null; // idempotent on replay
    const now = this.engine.now();

    switch (ev.name) {
      case 'Opened': {
        const buyer = this.engine.agentByWallet(ev.buyer);
        if (!buyer || buyer.id !== c.buyerId) throw new HoldworkError('WALLET_MISMATCH', `Opened by ${ev.buyer}, not the task's buyer`);
        this.engine.confirmFunding(c.id, ev.price, txHash);
        return `funded ${c.id}`;
      }
      case 'Committed': {
        const seller = this.engine.agentByWallet(ev.seller);
        if (!seller) throw new HoldworkError('UNKNOWN_WALLET', `Committed by unregistered wallet ${ev.seller}`);
        if (ev.stake !== c.stake) throw new HoldworkError('STAKE_MISMATCH', `Staked ${ev.stake}, contract requires ${c.stake}`);
        this.engine.ledger.deposit(seller.id, ev.stake, now, `chain stake ${txHash}`);
        this.engine.commit(c.id, seller.id);
        c.chain.committed = txHash;
        return `committed ${c.id} by ${seller.id}`;
      }
      case 'Accepted': {
        const p = c.pendingClaim;
        if (!p || p.kind !== 'ACCEPT') throw new HoldworkError('NO_PENDING_CLAIM', 'Accepted on-chain without a prepared claim');
        if (p.toSeller !== ev.toSeller) throw new HoldworkError('PAYOUT_MISMATCH', `Buyer released ${ev.toSeller}, prepared claim implied ${p.toSeller}`);
        this.engine.accept(c.id, c.buyerId, p.quality);
        c.chain.accepted = txHash;
        c.pendingClaim = undefined;
        return `accepted ${c.id}`;
      }
      case 'Disputed': {
        const p = c.pendingClaim;
        if (!p || p.kind !== 'DISPUTE') throw new HoldworkError('NO_PENDING_CLAIM', 'Disputed on-chain without a prepared claim');
        if (ev.bond !== c.bond) throw new HoldworkError('BOND_MISMATCH', `Bonded ${ev.bond}, contract requires ${c.bond}`);
        this.engine.ledger.deposit(c.buyerId, ev.bond, now, `chain bond ${txHash}`);
        this.engine.dispute(c.id, c.buyerId, p.quality, p.reason ?? '');
        c.chain.disputed = txHash;
        c.pendingClaim = undefined;
        return `disputed ${c.id}`;
      }
      case 'Settled':
        c.chain.settled = txHash;
        return `settled on-chain ${c.id}`;
      case 'Refunded':
        c.chain.refunded = txHash;
        return `refunded on-chain ${c.id}`;
    }
  }

  // ───────── arbiter: what Holdwork still owes the chain ─────────

  pendingArbiterActions(): ArbiterAction[] {
    const out: ArbiterAction[] = [];
    for (const c of this.engine.contracts.values()) {
      const ch = c.chain ?? {};
      if (!ch.opened) continue; // never funded on-chain: nothing to do there
      if (c.state === 'SETTLED' && c.settlement && c.settlement.qualitySource !== 'BUYER_CLAIM' && !ch.settled && !ch.settleSubmitted) {
        out.push({ contractId: c.id, action: 'settle', tx: prepareSettle(this.cfg, c, c.settlement) });
      } else if (c.state === 'CANCELLED' && !ch.refunded && !ch.refundSubmitted) {
        out.push({ contractId: c.id, action: 'refundUnfilled', tx: prepareRefundUnfilled(this.cfg, c) });
      } else if (c.state === 'EXPIRED' && !ch.refunded && !ch.refundSubmitted) {
        out.push({ contractId: c.id, action: 'refundMissedDelivery', tx: prepareRefundMissedDelivery(this.cfg, c) });
      }
    }
    return out;
  }

  markSubmitted(contractId: string, action: ArbiterAction['action'], txHash: string): void {
    const c = this.engine.contract(contractId);
    (c.chain ??= {})[action === 'settle' ? 'settleSubmitted' : 'refundSubmitted'] = txHash;
  }

  /** Human-readable summary for tool responses. */
  static describe(txs: PreparedTx[]): string[] {
    return txs.map((t) => `${t.description} → send to ${t.to} on chain ${t.chainId}`);
  }
}

export const MIN_GAS_HINT = usdc('0'); // placeholder so callers can display a gas note without importing viem
export type { Micro };
