/**
 * HoldworkOps: the operations the MCP tools call, independent of where the engine lives.
 * The stdio server implements it in-process; the Cloudflare Worker implements it over
 * Durable Object RPC. Every method returns a JSON-serializable envelope so error codes
 * survive any transport.
 */
import { HoldworkEngine, HoldworkError, fmt, usdc, type Agent, type Contract, type ComputeReport } from '../core/index.js';
import type { AutoVerifier } from '../verifier/index.js';

export type OpResult<T = unknown> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export interface HoldworkOps {
  registerAgent(a: { id?: string; operatorId: string; name: string; skills?: string[]; isVerifier?: boolean }): Promise<OpResult>;
  faucet(a: { agentId: string; amount: string }): Promise<OpResult>;
  setSpendPolicy(a: { operatorId: string; maxPerTask?: string; maxPerDay?: string; maxPerCounterpartyPerDay?: string; allowedCategories?: string[] }): Promise<OpResult>;
  createTask(a: {
    buyerId: string; title: string; description: string; category: string; price: string;
    acceptanceCriteria?: string; outputSchema?: unknown; offerWindowHours?: number; deliveryWindowHours?: number;
    fullPayQuality?: number; zeroPayQuality?: number;
  }): Promise<OpResult>;
  listOpenTasks(a: { category?: string }): Promise<OpResult>;
  commit(a: { contractId: string; sellerId: string }): Promise<OpResult>;
  deliver(a: { contractId: string; sellerId: string; output: unknown; compute: ComputeReport; notes?: string }): Promise<OpResult>;
  accept(a: { contractId: string; buyerId: string; qualityClaim: number }): Promise<OpResult>;
  requestRevision(a: { contractId: string; buyerId: string; qualityClaim: number; issues: string[] }): Promise<OpResult>;
  dispute(a: { contractId: string; buyerId: string; qualityClaim: number; reason: string }): Promise<OpResult>;
  attest(a: { contractId: string; verifierId: string; quality: number; confidence: number }): Promise<OpResult>;
  getContract(a: { contractId: string }): Promise<OpResult>;
  getAgent(a: { agentId: string }): Promise<OpResult>;
  tick(): Promise<OpResult>;
  runVerifiers(): Promise<OpResult>;
}

// ───────────── presentation ─────────────

export function contractView(c: Contract) {
  return {
    id: c.id,
    state: c.state,
    title: c.title,
    category: c.category,
    buyer: c.buyerId,
    seller: c.sellerId ?? null,
    price: fmt(c.price),
    stake: fmt(c.stake),
    bond: fmt(c.bond),
    thresholds: { fullPay: c.fullPayQuality, zeroPay: c.zeroPayQuality },
    deadlines: {
      offer: new Date(c.offerDeadline).toISOString(),
      delivery: c.deliveryDeadline ? new Date(c.deliveryDeadline).toISOString() : null,
      assessment: c.assessmentDeadline ? new Date(c.assessmentDeadline).toISOString() : null,
    },
    deliveries: c.deliveries.length,
    revisions: c.revisions,
    buyerClaim: c.buyerClaim ?? null,
    verification: c.verification.map((r) => ({
      round: r.round, reason: r.reason, verifiers: r.verifierIds, attestations: r.attestations.length,
      deadline: new Date(r.deadline).toISOString(), result: r.result ?? null,
    })),
    calibrationSample: c.calibrationSample ?? null,
    settlement: c.settlement
      ? {
          quality: c.settlement.quality, source: c.settlement.qualitySource,
          toSeller: fmt(c.settlement.toSeller), fee: fmt(c.settlement.fee), sellerNet: fmt(c.settlement.sellerNet),
          refund: fmt(c.settlement.refund), stakeReturned: fmt(c.settlement.stakeReturned),
          bondReturned: fmt(c.settlement.bondReturned), bondForfeited: fmt(c.settlement.bondForfeited),
          verifierFeesPaid: fmt(c.settlement.verifierFeesPaid), verifierFeesPaidBy: c.settlement.verifierFeesPaidBy,
        }
      : null,
    latestOutput: c.deliveries.at(-1)?.output ?? null,
    events: c.events.slice(-12),
  };
}

export function agentView(engine: HoldworkEngine, a: Agent) {
  return {
    id: a.id, operator: a.operatorId, name: a.name, skills: a.skills, isVerifier: a.isVerifier,
    reputation: +a.reputation.toFixed(3), verifierCalibration: +a.verifierCalibration.toFixed(3),
    buyerCalibration: +a.buyer.calibration.toFixed(3), buyerBias: +a.buyer.bias.toFixed(3),
    balance: fmt(engine.balance(a.id)),
  };
}

// ───────────── in-process implementation ─────────────

export interface LocalOpsHooks {
  /** Called after every successful mutation (persist). */
  save?: () => void | Promise<void>;
  autoVerifier?: AutoVerifier | null;
}

/** Runs the engine in-process. Used by the stdio server and inside the Durable Object. */
export class LocalOps implements HoldworkOps {
  constructor(private readonly engine: HoldworkEngine, private readonly hooks: LocalOpsHooks = {}) {}

  private async run<T>(fn: () => T): Promise<OpResult<T>> {
    try {
      const result = fn();
      await this.hooks.save?.();
      await this.autoVerify();
      return { ok: true, result };
    } catch (e) {
      const error = e instanceof HoldworkError ? { code: e.code, message: e.message } : { code: 'ERROR', message: String(e) };
      return { ok: false, error };
    }
  }

  private async autoVerify(): Promise<void> {
    const av = this.hooks.autoVerifier;
    if (!av || av.pending().length === 0) return;
    try {
      await av.run();
      await this.hooks.save?.();
    } catch (e) {
      console.error(`[holdwork] auto-verify failed: ${String(e)}`);
    }
  }

  registerAgent(a: Parameters<HoldworkOps['registerAgent']>[0]) {
    return this.run(() => agentView(this.engine, this.engine.registerAgent(a)));
  }
  faucet(a: { agentId: string; amount: string }) {
    return this.run(() => ({ agentId: a.agentId, balance: fmt(this.engine.faucet(a.agentId, usdc(a.amount))) }));
  }
  setSpendPolicy(a: Parameters<HoldworkOps['setSpendPolicy']>[0]) {
    return this.run(() => {
      this.engine.setSpendPolicy(a.operatorId, {
        maxPerTask: a.maxPerTask ? usdc(a.maxPerTask) : undefined,
        maxPerDay: a.maxPerDay ? usdc(a.maxPerDay) : undefined,
        maxPerCounterpartyPerDay: a.maxPerCounterpartyPerDay ? usdc(a.maxPerCounterpartyPerDay) : undefined,
        allowedCategories: a.allowedCategories,
      });
      return { operatorId: a.operatorId, policy: a };
    });
  }
  createTask(a: Parameters<HoldworkOps['createTask']>[0]) {
    return this.run(() => contractView(this.engine.createTask({
      ...a, price: usdc(a.price),
      offerWindowMs: a.offerWindowHours ? a.offerWindowHours * 3600_000 : undefined,
      deliveryWindowMs: a.deliveryWindowHours ? a.deliveryWindowHours * 3600_000 : undefined,
    })));
  }
  listOpenTasks(a: { category?: string }) {
    return this.run(() => this.engine.listOpenTasks(a.category).map(contractView));
  }
  commit(a: { contractId: string; sellerId: string }) {
    return this.run(() => contractView(this.engine.commit(a.contractId, a.sellerId)));
  }
  deliver(a: Parameters<HoldworkOps['deliver']>[0]) {
    return this.run(() => contractView(this.engine.deliver(a.contractId, a.sellerId, a.output, a.compute, a.notes)));
  }
  accept(a: { contractId: string; buyerId: string; qualityClaim: number }) {
    return this.run(() => contractView(this.engine.accept(a.contractId, a.buyerId, a.qualityClaim)));
  }
  requestRevision(a: { contractId: string; buyerId: string; qualityClaim: number; issues: string[] }) {
    return this.run(() => contractView(this.engine.requestRevision(a.contractId, a.buyerId, a.qualityClaim, a.issues)));
  }
  dispute(a: { contractId: string; buyerId: string; qualityClaim: number; reason: string }) {
    return this.run(() => contractView(this.engine.dispute(a.contractId, a.buyerId, a.qualityClaim, a.reason)));
  }
  attest(a: { contractId: string; verifierId: string; quality: number; confidence: number }) {
    return this.run(() => contractView(this.engine.attest(a.contractId, a.verifierId, a.quality, a.confidence)));
  }
  getContract(a: { contractId: string }) {
    return this.run(() => contractView(this.engine.contract(a.contractId)));
  }
  getAgent(a: { agentId: string }) {
    return this.run(() => agentView(this.engine, this.engine.agent(a.agentId)));
  }
  tick() {
    return this.run(() => this.engine.tick().map(contractView));
  }
  async runVerifiers(): Promise<OpResult> {
    const av = this.hooks.autoVerifier;
    if (!av) return { ok: true, result: { configured: false, hint: 'set HOLDWORK_AUTO_VERIFIERS' } };
    try {
      const attested = await av.run();
      await this.hooks.save?.();
      return { ok: true, result: { configured: true, attested } };
    } catch (e) {
      return { ok: false, error: { code: 'SCORER_ERROR', message: String(e) } };
    }
  }
}
