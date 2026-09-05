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
  registerAgent(a: { id?: string; operatorId: string; name: string; skills?: string[]; isVerifier?: boolean; wallet?: string }): Promise<OpResult>;
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
  stats(): Promise<OpResult<Stats>>;
  myAssignments(a: { verifierId: string }): Promise<OpResult>;
}

/** Operating metrics. These are the numbers the board report is built from. */
export interface Stats {
  agents: number;
  operators: number;
  verifiers: number;
  contractsByState: Record<string, number>;
  settled: number;
  settledVolume: string;
  feesEarned: string;
  disputes: number;
  disputesBuyerVindicated: number;
  calibrationSamples: number;
  attestations: number;
  zeroConfidenceAttestations: number;
  avgSettledQuality: number | null;
  medianDisputeSettleSeconds: number | null;
  ledgerTotal: string;
}

export function computeStats(engine: HoldworkEngine): Stats {
  const contracts = [...engine.contracts.values()];
  const byState: Record<string, number> = {};
  let settled = 0, volume = 0n, fees = 0n, disputes = 0, vindicated = 0, samples = 0, atts = 0, zeroConf = 0, qualitySum = 0;
  const disputeSeconds: number[] = [];
  for (const c of contracts) {
    byState[c.state] = (byState[c.state] ?? 0) + 1;
    if (c.settlement) {
      settled++;
      volume += c.settlement.toSeller;
      fees += c.settlement.fee;
      qualitySum += c.settlement.quality;
    }
    if (c.calibrationSample?.sampled) samples++;
    const disputedAt = c.events.find((e) => e.type === 'DISPUTED')?.at;
    if (disputedAt !== undefined) {
      disputes++;
      if (c.settlement?.verifierFeesPaidBy === 'SELLER_STAKE') vindicated++;
      if (c.settlement) disputeSeconds.push((c.settlement.settledAt - disputedAt) / 1000);
    }
    for (const r of c.verification) {
      atts += r.attestations.length;
      zeroConf += r.attestations.filter((a) => a.confidence === 0).length;
    }
  }
  // feesEarned counts settlement fees only; the fee account balance may also hold forfeited bonds.
  disputeSeconds.sort((a, b) => a - b);
  const agents = [...engine.agents.values()];
  return {
    agents: agents.length,
    operators: engine.operators.size,
    verifiers: agents.filter((a) => a.isVerifier).length,
    contractsByState: byState,
    settled,
    settledVolume: fmt(volume),
    feesEarned: fmt(fees),
    disputes,
    disputesBuyerVindicated: vindicated,
    calibrationSamples: samples,
    attestations: atts,
    zeroConfidenceAttestations: zeroConf,
    avgSettledQuality: settled ? +(qualitySum / settled).toFixed(3) : null,
    medianDisputeSettleSeconds: disputeSeconds.length ? Math.round(disputeSeconds[Math.floor(disputeSeconds.length / 2)]) : null,
    ledgerTotal: fmt(engine.ledger.total()),
  };
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
    criteriaHash: c.criteriaHash ?? null,
    deadlines: {
      offer: new Date(c.offerDeadline).toISOString(),
      delivery: c.deliveryDeadline ? new Date(c.deliveryDeadline).toISOString() : null,
      assessment: c.assessmentDeadline ? new Date(c.assessmentDeadline).toISOString() : null,
    },
    deliveries: c.deliveries.length,
    revisions: c.revisions,
    buyerClaim: c.buyerClaim ?? null,
    pendingClaim: c.pendingClaim ? { kind: c.pendingClaim.kind, quality: c.pendingClaim.quality, toSeller: fmt(c.pendingClaim.toSeller) } : null,
    chain: c.chain ?? null,
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
          criteriaHash: c.settlement.criteriaHash ?? null, evidenceHash: c.settlement.evidenceHash ?? null,
        }
      : null,
    latestOutput: c.deliveries.at(-1)?.output ?? null,
    events: c.events.slice(-12),
  };
}

export function agentView(engine: HoldworkEngine, a: Agent) {
  return {
    id: a.id, operator: a.operatorId, name: a.name, skills: a.skills, isVerifier: a.isVerifier, wallet: a.wallet ?? null,
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
  /**
   * When set, LocalOps does not score inline after a mutation; it calls this so the host can run
   * verification in the background (model scoring can take a minute per verifier). The host is
   * then responsible for calling runVerifiers().
   */
  deferAutoVerify?: () => void | Promise<void>;
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

  /** True when a model verifier is configured and has outstanding assignments. */
  hasPendingVerification(): boolean {
    return (this.hooks.autoVerifier?.pending().length ?? 0) > 0;
  }

  private async autoVerify(): Promise<void> {
    const av = this.hooks.autoVerifier;
    if (!av || av.pending().length === 0) return;
    if (this.hooks.deferAutoVerify) {
      await this.hooks.deferAutoVerify();
      return;
    }
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
  async stats(): Promise<OpResult<Stats>> {
    return { ok: true, result: computeStats(this.engine) };
  }
  myAssignments(a: { verifierId: string }) {
    return this.run(() => this.engine.pendingAssignments(a.verifierId).map((x) => ({ ...x, deadline: new Date(x.deadline).toISOString() })));
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
