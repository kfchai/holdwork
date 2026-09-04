import { randomUUID } from 'node:crypto';
import { bps, maxMicro, minMicro, type Micro } from './money.js';
import { DEFAULT_PARAMS, type Params } from './params.js';
import { selectVerifiers, shouldSample } from './sampling.js';
import { computePayout } from './payout.js';
import { consensus, ewma, updateBuyerCalibration, updateVerifierCalibration } from './calibration.js';
import { Ledger, FEE_ACCOUNT, bondAccount, escrowAccount, stakeAccount } from './ledger.js';
import {
  HoldworkError,
  type Agent,
  type Attestation,
  type ComputeReport,
  type Contract,
  type ContractEvent,
  type Operator,
  type PairMetrics,
  type Settlement,
  type SpendPolicy,
  type VerificationRound,
} from './types.js';

export interface EngineOptions {
  networkKey: string;
  params?: Partial<Params>;
  now?: () => number;
  ledger?: Ledger;
}

export interface CreateTaskInput {
  buyerId: string;
  title: string;
  description: string;
  category: string;
  outputSchema?: unknown;
  acceptanceCriteria?: string;
  price: Micro;
  offerWindowMs?: number;
  deliveryWindowMs?: number;
  fullPayQuality?: number;
  zeroPayQuality?: number;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * HoldworkEngine: the whole product in one class.
 * Contract state machine, spend policy, escrow ledger, sampling, verifier assignment,
 * consensus, payout, and reputation. Deterministic given networkKey and a clock.
 */
export class HoldworkEngine {
  readonly params: Params;
  readonly ledger: Ledger;
  readonly agents = new Map<string, Agent>();
  readonly operators = new Map<string, Operator>();
  readonly contracts = new Map<string, Contract>();
  readonly pairs = new Map<string, PairMetrics>();
  private readonly networkKey: string;
  private readonly clock: () => number;

  constructor(opts: EngineOptions) {
    this.networkKey = opts.networkKey;
    this.params = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
    this.clock = opts.now ?? (() => Date.now());
    this.ledger = opts.ledger ?? new Ledger();
  }

  now(): number {
    return this.clock();
  }

  // ───────────────────────── agents and operators ─────────────────────────

  registerAgent(input: {
    id?: string;
    operatorId: string;
    name: string;
    skills?: string[];
    isVerifier?: boolean;
  }): Agent {
    const id = input.id ?? `agent_${randomUUID().slice(0, 8)}`;
    if (this.agents.has(id)) throw new HoldworkError('AGENT_EXISTS', `Agent ${id} already registered`);
    if (!this.operators.has(input.operatorId)) this.operators.set(input.operatorId, { id: input.operatorId, policy: {} });
    const agent: Agent = {
      id,
      operatorId: input.operatorId,
      name: input.name,
      skills: input.skills ?? [],
      isVerifier: input.isVerifier ?? false,
      reputation: this.params.initialReputation,
      verifierCalibration: this.params.initialCalibration,
      buyer: { calibration: this.params.initialCalibration, bias: 0, sampledCount: 0 },
      registeredAt: this.now(),
    };
    this.agents.set(id, agent);
    return agent;
  }

  setSpendPolicy(operatorId: string, policy: SpendPolicy): Operator {
    const op = this.operators.get(operatorId) ?? { id: operatorId, policy: {} };
    op.policy = { ...policy };
    this.operators.set(operatorId, op);
    return op;
  }

  /** Ledger-mode only: credit an agent with test funds. */
  faucet(agentId: string, amount: Micro): Micro {
    this.agent(agentId);
    this.ledger.deposit(agentId, amount, this.now(), 'faucet');
    return this.ledger.balance(agentId);
  }

  balance(agentId: string): Micro {
    return this.ledger.balance(agentId);
  }

  agent(id: string): Agent {
    const a = this.agents.get(id);
    if (!a) throw new HoldworkError('UNKNOWN_AGENT', `Agent ${id} is not registered`);
    return a;
  }

  contract(id: string): Contract {
    const c = this.contracts.get(id);
    if (!c) throw new HoldworkError('UNKNOWN_CONTRACT', `Contract ${id} does not exist`);
    return c;
  }

  // ───────────────────────── buyer: create ─────────────────────────

  createTask(input: CreateTaskInput): Contract {
    const buyer = this.agent(input.buyerId);
    if (input.price <= 0n) throw new HoldworkError('INVALID_PRICE', 'Price must be positive');
    const fullPay = input.fullPayQuality ?? this.params.defaultFullPayQuality;
    const zeroPay = input.zeroPayQuality ?? this.params.defaultZeroPayQuality;
    if (fullPay < 0.5 || fullPay > 1) throw new HoldworkError('INVALID_THRESHOLD', 'fullPayQuality must be in [0.5, 1]');
    if (zeroPay < 0 || zeroPay >= fullPay) throw new HoldworkError('INVALID_THRESHOLD', 'zeroPayQuality must be in [0, fullPayQuality)');

    this.enforcePolicy(buyer, input.price, input.category, undefined);

    const now = this.now();
    const id = `hw_${randomUUID().slice(0, 12)}`;
    const contract: Contract = {
      id,
      state: 'OPEN',
      buyerId: buyer.id,
      buyerOperatorId: buyer.operatorId,
      title: input.title,
      description: input.description,
      category: input.category,
      outputSchema: input.outputSchema ?? null,
      acceptanceCriteria: input.acceptanceCriteria ?? '',
      price: input.price,
      stake: maxMicro(bps(input.price, this.params.sellerStakeBps), this.params.minStake),
      bond: maxMicro(bps(input.price, this.params.disputeBondBps), this.params.minBond),
      fullPayQuality: fullPay,
      zeroPayQuality: zeroPay,
      createdAt: now,
      offerDeadline: now + (input.offerWindowMs ?? DAY),
      deliveryWindowMs: input.deliveryWindowMs ?? DAY,
      deliveries: [],
      revisions: [],
      verification: [],
      events: [],
    };
    this.ledger.transfer(buyer.id, escrowAccount(id), input.price, now, 'lock budget');
    this.contracts.set(id, contract);
    this.log(contract, 'CREATED', buyer.id, { price: input.price.toString() });
    return contract;
  }

  listOpenTasks(category?: string): Contract[] {
    return [...this.contracts.values()].filter((c) => c.state === 'OPEN' && (!category || c.category === category));
  }

  // ───────────────────────── seller: commit and deliver ─────────────────────────

  commit(contractId: string, sellerId: string): Contract {
    const c = this.contract(contractId);
    const seller = this.agent(sellerId);
    this.expect(c, 'OPEN');
    if (this.now() > c.offerDeadline) throw new HoldworkError('OFFER_EXPIRED', 'Offer deadline has passed');
    if (seller.operatorId === c.buyerOperatorId) {
      throw new HoldworkError('SELF_DEALING', 'Buyer and seller must belong to different operators');
    }
    const buyer = this.agent(c.buyerId);
    this.enforcePolicy(buyer, c.price, c.category, seller.id, c.id);

    const now = this.now();
    this.ledger.transfer(seller.id, stakeAccount(c.id), c.stake, now, 'lock seller stake');
    c.sellerId = seller.id;
    c.sellerOperatorId = seller.operatorId;
    c.state = 'COMMITTED';
    c.deliveryDeadline = now + c.deliveryWindowMs;
    this.log(c, 'COMMITTED', seller.id, { stake: c.stake.toString(), deliveryDeadline: c.deliveryDeadline });
    return c;
  }

  deliver(contractId: string, sellerId: string, output: unknown, compute: ComputeReport, notes?: string): Contract {
    const c = this.contract(contractId);
    this.expectSeller(c, sellerId);
    if (c.state !== 'COMMITTED' && c.state !== 'REVISION_REQUESTED') {
      throw new HoldworkError('BAD_STATE', `Cannot deliver in state ${c.state}`);
    }
    const now = this.now();
    if (c.state === 'COMMITTED' && c.deliveryDeadline && now > c.deliveryDeadline) {
      throw new HoldworkError('DELIVERY_EXPIRED', 'Delivery deadline has passed');
    }
    if (c.state === 'REVISION_REQUESTED') {
      const last = c.revisions[c.revisions.length - 1];
      if (now > last.deadline) throw new HoldworkError('REVISION_EXPIRED', 'Revision deadline has passed');
    }
    this.validateCompute(compute);
    c.deliveries.push({ round: c.deliveries.length + 1, output, compute, notes, deliveredAt: now });
    c.state = 'DELIVERED';
    c.assessmentDeadline = now + this.params.assessmentWindowMs;
    this.log(c, 'DELIVERED', sellerId, { round: c.deliveries.length, measurement: compute.measurement });
    return c;
  }

  // ───────────────────────── buyer: assess ─────────────────────────

  accept(contractId: string, buyerId: string, qualityClaim: number): Contract {
    const c = this.contract(contractId);
    this.expectBuyer(c, buyerId);
    this.expect(c, 'DELIVERED');
    this.validateQuality(qualityClaim);
    const now = this.now();
    c.buyerClaim = qualityClaim;
    c.state = 'ACCEPTED';
    this.log(c, 'ACCEPTED', buyerId, { qualityClaim });

    // Fast path: settle now from the buyer's claim. Sampling runs after the fact.
    this.settle(c, qualityClaim, 'BUYER_CLAIM', { verifierFeesPaidBy: 'NONE' });

    const rate = this.sampleRateFor(c);
    const sampled = shouldSample(this.networkKey, c.id, c.buyerId, c.createdAt, rate);
    c.calibrationSample = { sampled, rate, completed: !sampled };
    if (sampled) {
      this.openVerification(c, 'CALIBRATION_SAMPLE');
      this.log(c, 'CALIBRATION_SAMPLED', undefined, { rate });
    }
    // Sampled contracts stay SETTLED for money purposes; the verification round is informational.
    c.state = 'SETTLED';
    c.settlement!.settledAt = now;
    return c;
  }

  requestRevision(contractId: string, buyerId: string, qualityClaim: number, issues: string[]): Contract {
    const c = this.contract(contractId);
    this.expectBuyer(c, buyerId);
    this.expect(c, 'DELIVERED');
    this.validateQuality(qualityClaim);
    if (!issues?.length) throw new HoldworkError('NO_ISSUES', 'At least one issue is required');
    if (issues.length > this.params.maxRevisionIssues) {
      throw new HoldworkError('TOO_MANY_ISSUES', `At most ${this.params.maxRevisionIssues} issues per request`);
    }
    if (c.revisions.length >= this.params.maxRevisionRounds) {
      throw new HoldworkError('REVISION_LIMIT', 'Revision limit reached, accept or dispute');
    }
    const now = this.now();
    c.buyerClaim = qualityClaim;
    c.revisions.push({
      round: c.revisions.length + 1,
      qualityClaim,
      issues,
      requestedAt: now,
      deadline: now + this.params.revisionWindowMs,
    });
    c.state = 'REVISION_REQUESTED';
    this.log(c, 'REVISION_REQUESTED', buyerId, { round: c.revisions.length, issues: issues.length });
    return c;
  }

  dispute(contractId: string, buyerId: string, qualityClaim: number, reason: string): Contract {
    const c = this.contract(contractId);
    this.expectBuyer(c, buyerId);
    this.expect(c, 'DELIVERED');
    this.validateQuality(qualityClaim);
    const now = this.now();
    this.ledger.transfer(buyerId, bondAccount(c.id), c.bond, now, 'lock dispute bond');
    c.buyerClaim = qualityClaim;
    c.disputeReason = reason;
    c.state = 'DISPUTED';
    this.log(c, 'DISPUTED', buyerId, { qualityClaim, bond: c.bond.toString() });
    this.openVerification(c, 'DISPUTE');
    return c;
  }

  // ───────────────────────── verifiers ─────────────────────────

  attest(contractId: string, verifierId: string, quality: number, confidence: number): Contract {
    const c = this.contract(contractId);
    const round = this.activeRound(c);
    if (!round) throw new HoldworkError('NO_ACTIVE_VERIFICATION', 'No verification round is open');
    if (!round.verifierIds.includes(verifierId)) {
      throw new HoldworkError('NOT_ASSIGNED', `Verifier ${verifierId} is not assigned to this round`);
    }
    if (round.attestations.some((a) => a.verifierId === verifierId)) {
      throw new HoldworkError('ALREADY_ATTESTED', 'Verifier already attested this round');
    }
    this.validateQuality(quality);
    this.validateQuality(confidence, 'confidence');
    const att: Attestation = { verifierId, quality, confidence, submittedAt: this.now() };
    round.attestations.push(att);
    this.log(c, 'ATTESTED', verifierId, { round: round.round });
    if (round.attestations.length >= round.verifierIds.length) this.closeRound(c, round);
    return c;
  }

  /** Advance time-based transitions. Call periodically or after changing the clock. */
  tick(): Contract[] {
    const now = this.now();
    const touched: Contract[] = [];
    for (const c of this.contracts.values()) {
      const before = c.state + ':' + c.verification.length + ':' + (c.calibrationSample?.completed ?? '');
      switch (c.state) {
        case 'OPEN':
          if (now > c.offerDeadline) this.cancel(c, 'OFFER_TIMEOUT');
          break;
        case 'COMMITTED':
          if (c.deliveryDeadline && now > c.deliveryDeadline) this.expire(c);
          break;
        case 'DELIVERED':
          if (c.assessmentDeadline && now > c.assessmentDeadline) {
            c.state = 'VERIFYING';
            this.log(c, 'ASSESSMENT_TIMEOUT');
            this.openVerification(c, 'ASSESSMENT_TIMEOUT');
          }
          break;
        case 'REVISION_REQUESTED': {
          const last = c.revisions[c.revisions.length - 1];
          if (now > last.deadline) {
            c.state = 'DISPUTED';
            this.log(c, 'REVISION_TIMEOUT', undefined, { round: last.round });
            this.openVerification(c, 'REVISION_TIMEOUT');
          }
          break;
        }
        case 'VERIFYING':
        case 'SETTLED': {
          const round = this.activeRound(c);
          if (round && now > round.deadline) this.closeRound(c, round, true);
          break;
        }
      }
      const after = c.state + ':' + c.verification.length + ':' + (c.calibrationSample?.completed ?? '');
      if (before !== after) touched.push(c);
    }
    return touched;
  }

  // ───────────────────────── internals: verification ─────────────────────────

  private openVerification(c: Contract, reason: VerificationRound['reason']): VerificationRound {
    const excluded = new Set([c.buyerOperatorId, c.sellerOperatorId]);
    const candidates = [...this.agents.values()]
      .filter((a) => a.isVerifier && !excluded.has(a.operatorId))
      .map((a) => ({ id: a.id, weight: a.verifierCalibration }));
    const roundNo = c.verification.length + 1;
    const alreadyUsed = new Set(c.verification.flatMap((r) => r.verifierIds));
    const fresh = reason === 'COLLUSION_RERUN' ? candidates.filter((x) => !alreadyUsed.has(x.id)) : candidates;
    const pool = fresh.length >= this.params.verifiersPerDispute ? fresh : candidates;
    const verifierIds = selectVerifiers(this.networkKey, c.id, roundNo, pool, this.params.verifiersPerDispute);
    const round: VerificationRound = {
      round: roundNo,
      reason,
      verifierIds,
      attestations: [],
      deadline: this.now() + this.params.verificationWindowMs,
    };
    c.verification.push(round);
    if (c.state !== 'SETTLED') c.state = 'VERIFYING';
    this.log(c, 'VERIFICATION_OPENED', undefined, { round: roundNo, reason, verifiers: verifierIds });
    if (verifierIds.length === 0) this.closeRound(c, round, true);
    return round;
  }

  private activeRound(c: Contract): VerificationRound | undefined {
    const last = c.verification[c.verification.length - 1];
    return last && !last.result ? last : undefined;
  }

  private closeRound(c: Contract, round: VerificationRound, byTimeout = false): void {
    const atts = round.attestations;
    const isSample = round.reason === 'CALIBRATION_SAMPLE';

    if (atts.length < 2) {
      // Not enough attestations. One replacement round, then fall back.
      const priorRounds = c.verification.filter((r) => r.reason === round.reason).length;
      round.result = { quality: NaN, lowConfidence: true, lowVariance: false };
      if (priorRounds < 2 && this.verifierPoolSize(c) > 0 && byTimeout) {
        this.log(c, 'VERIFICATION_REPLACEMENT', undefined, { round: round.round });
        this.openVerification(c, round.reason);
        return;
      }
      if (isSample) {
        c.calibrationSample!.completed = true;
        this.log(c, 'CALIBRATION_UNVERIFIABLE');
        return;
      }
      const fallback = c.buyerClaim ?? c.fullPayQuality;
      this.log(c, 'VERIFICATION_UNVERIFIABLE', undefined, { fallbackQuality: fallback });
      this.settle(c, fallback, 'DEFAULT', { verifierFeesPaidBy: 'NONE' });
      this.returnBondAndStake(c);
      return;
    }

    const result = consensus(
      atts.map((a) => ({ ...a, calibration: this.agent(a.verifierId).verifierCalibration })),
      this.params.minRoundVariance,
    );
    round.result = { quality: result.quality, lowConfidence: result.lowConfidence, lowVariance: result.lowVariance };

    if (result.lowVariance && !c.verification.some((r) => r.reason === 'COLLUSION_RERUN')) {
      this.log(c, 'COLLUSION_SUSPECTED', undefined, { round: round.round, variance: result.variance });
      this.openVerification(c, 'COLLUSION_RERUN');
      return;
    }

    for (const a of atts) {
      const v = this.agent(a.verifierId);
      v.verifierCalibration = updateVerifierCalibration(
        v.verifierCalibration, a.quality, a.confidence, result.quality, this.params.calibrationAlpha,
      );
    }

    if (isSample) {
      this.completeCalibrationSample(c, round, result.quality);
      return;
    }
    this.settleFromNetwork(c, round, result.quality);
  }

  private completeCalibrationSample(c: Contract, round: VerificationRound, networkQuality: number): void {
    const buyer = this.agent(c.buyerId);
    const { profile, delta } = updateBuyerCalibration(buyer.buyer, c.buyerClaim!, networkQuality, this.params.calibrationAlpha);
    buyer.buyer = profile;
    if (delta > this.params.calibrationTolerance) {
      buyer.reputation = Math.max(0, buyer.reputation - Math.min(0.15, delta));
    }
    this.updatePair(c, c.buyerClaim!, networkQuality);
    const paid = this.payVerifiers(c, round, FEE_ACCOUNT);
    if (c.settlement) c.settlement.verifierFeesPaid += paid;
    c.calibrationSample = { ...c.calibrationSample!, completed: true, networkQuality, delta };
    this.log(c, 'CALIBRATION_COMPLETED', undefined, { networkQuality, delta });
  }

  private settleFromNetwork(c: Contract, round: VerificationRound, quality: number): void {
    const now = this.now();
    const hadBond = this.ledger.balance(bondAccount(c.id)) > 0n;
    const claim = c.buyerClaim;
    const vindicated = claim === undefined ? true : quality <= claim + this.params.calibrationTolerance;

    let feesPaidBy: Settlement['verifierFeesPaidBy'] = 'HOLDWORK';
    let bondReturned = 0n, bondForfeited = 0n, stakeForfeitedForFees = 0n, verifierFeesPaid = 0n;
    const fees = this.params.verifierFee * BigInt(round.attestations.length);

    if (hadBond && !vindicated) {
      // Buyer lost the dispute: bond pays verifiers, remainder to Holdwork.
      const bond = this.ledger.balance(bondAccount(c.id));
      verifierFeesPaid = this.payVerifiers(c, round, bondAccount(c.id), minMicro(bond, fees));
      bondForfeited = bond;
      const remainder = this.ledger.balance(bondAccount(c.id));
      if (remainder > 0n) this.ledger.transfer(bondAccount(c.id), FEE_ACCOUNT, remainder, now, 'forfeited bond remainder');
      feesPaidBy = 'BUYER_BOND';
    } else if (round.reason !== 'ASSESSMENT_TIMEOUT') {
      // Buyer vindicated (or revision timeout): seller's stake pays verifiers.
      const stake = this.ledger.balance(stakeAccount(c.id));
      verifierFeesPaid = this.payVerifiers(c, round, stakeAccount(c.id), minMicro(stake, fees));
      stakeForfeitedForFees = verifierFeesPaid;
      feesPaidBy = 'SELLER_STAKE';
      if (hadBond) {
        bondReturned = this.ledger.balance(bondAccount(c.id));
        this.ledger.transfer(bondAccount(c.id), c.buyerId, bondReturned, now, 'return dispute bond');
      }
    } else {
      // Buyer went silent: Holdwork absorbs verification cost.
      verifierFeesPaid = this.payVerifiers(c, round, FEE_ACCOUNT);
    }

    if (claim !== undefined) {
      const buyer = this.agent(c.buyerId);
      buyer.buyer = updateBuyerCalibration(buyer.buyer, claim, quality, this.params.calibrationAlpha).profile;
      this.updatePair(c, claim, quality);
    }

    this.settle(c, quality, 'NETWORK', {
      verifierFeesPaidBy: feesPaidBy, verifierFeesPaid, bondReturned, bondForfeited, stakeForfeited: stakeForfeitedForFees,
    });
    // Return whatever stake remains.
    const stakeLeft = this.ledger.balance(stakeAccount(c.id));
    if (stakeLeft > 0n) {
      this.ledger.transfer(stakeAccount(c.id), c.sellerId!, stakeLeft, now, 'return seller stake');
      c.settlement!.stakeReturned = stakeLeft;
    }
    this.log(c, 'DISPUTE_RESOLVED', undefined, { quality, vindicated, feesPaidBy });
  }

  /** Pay each attesting verifier the fixed fee from `from`, up to `cap`. Returns the total paid. */
  private payVerifiers(c: Contract, round: VerificationRound, from: string, cap?: Micro): Micro {
    const now = this.now();
    let paid = 0n;
    let remaining = cap ?? this.params.verifierFee * BigInt(round.attestations.length);
    for (const a of round.attestations) {
      const amt = minMicro(this.params.verifierFee, remaining);
      if (amt <= 0n) break;
      if (from === FEE_ACCOUNT && this.ledger.balance(FEE_ACCOUNT) < amt) break; // Holdwork pays only what it has
      this.ledger.transfer(from, a.verifierId, amt, now, `verifier fee ${c.id} r${round.round}`);
      paid += amt;
      remaining -= amt;
    }
    return paid;
  }

  // ───────────────────────── internals: settlement ─────────────────────────

  private settle(
    c: Contract,
    quality: number,
    source: Settlement['qualitySource'],
    extra: Partial<Settlement>,
  ): void {
    if (c.settlement) return; // idempotent: money moves once
    const now = this.now();
    const p = computePayout(c.price, quality, c.fullPayQuality, c.zeroPayQuality, this.params);
    const esc = escrowAccount(c.id);
    if (p.sellerNet > 0n) this.ledger.transfer(esc, c.sellerId!, p.sellerNet, now, 'release to seller');
    if (p.fee > 0n) this.ledger.transfer(esc, FEE_ACCOUNT, p.fee, now, 'holdwork fee');
    if (p.refund > 0n) this.ledger.transfer(esc, c.buyerId, p.refund, now, 'refund to buyer');

    const seller = this.agent(c.sellerId!);
    seller.reputation = ewma(seller.reputation, quality, this.params.reputationAlpha);

    // Fast-path stake return happens here; network path returns remaining stake afterwards.
    let stakeReturned = 0n;
    if (source === 'BUYER_CLAIM') {
      stakeReturned = this.ledger.balance(stakeAccount(c.id));
      if (stakeReturned > 0n) this.ledger.transfer(stakeAccount(c.id), c.sellerId!, stakeReturned, now, 'return seller stake');
    }

    c.settlement = {
      quality,
      qualitySource: source,
      toSeller: p.toSeller,
      fee: p.fee,
      sellerNet: p.sellerNet,
      refund: p.refund,
      stakeReturned,
      stakeForfeited: 0n,
      bondReturned: 0n,
      bondForfeited: 0n,
      verifierFeesPaid: 0n,
      verifierFeesPaidBy: 'NONE',
      settledAt: now,
      ...extra,
    };
    c.state = 'SETTLED';
    this.log(c, 'SETTLED', undefined, {
      quality, source, sellerNet: p.sellerNet.toString(), fee: p.fee.toString(), refund: p.refund.toString(),
    });
  }

  private returnBondAndStake(c: Contract): void {
    const now = this.now();
    const bond = this.ledger.balance(bondAccount(c.id));
    if (bond > 0n) this.ledger.transfer(bondAccount(c.id), c.buyerId, bond, now, 'return dispute bond');
    const stake = this.ledger.balance(stakeAccount(c.id));
    if (stake > 0n && c.sellerId) this.ledger.transfer(stakeAccount(c.id), c.sellerId, stake, now, 'return seller stake');
    if (c.settlement) {
      c.settlement.bondReturned += bond;
      c.settlement.stakeReturned += stake;
    }
  }

  private cancel(c: Contract, reason: string): void {
    const now = this.now();
    const esc = this.ledger.balance(escrowAccount(c.id));
    this.ledger.transfer(escrowAccount(c.id), c.buyerId, esc, now, 'refund: cancelled');
    c.state = 'CANCELLED';
    this.log(c, 'CANCELLED', undefined, { reason, refund: esc.toString() });
  }

  private expire(c: Contract): void {
    const now = this.now();
    const esc = this.ledger.balance(escrowAccount(c.id));
    const stake = this.ledger.balance(stakeAccount(c.id));
    this.ledger.transfer(escrowAccount(c.id), c.buyerId, esc, now, 'refund: seller missed deadline');
    this.ledger.transfer(stakeAccount(c.id), c.buyerId, stake, now, 'stake forfeited to buyer');
    const seller = this.agent(c.sellerId!);
    seller.reputation = Math.max(0, seller.reputation - this.params.nonDeliveryPenalty);
    c.state = 'EXPIRED';
    this.log(c, 'EXPIRED', undefined, { refund: esc.toString(), stakeForfeited: stake.toString() });
  }

  // ───────────────────────── internals: policy, pairs, helpers ─────────────────────────

  private enforcePolicy(buyer: Agent, price: Micro, category: string, sellerId?: string, excludeContractId?: string): void {
    const policy = this.operators.get(buyer.operatorId)?.policy ?? {};
    if (policy.maxPerTask !== undefined && price > policy.maxPerTask) {
      throw new HoldworkError('POLICY_MAX_PER_TASK', `Price ${price} exceeds max_per_task ${policy.maxPerTask}`);
    }
    if (policy.allowedCategories && !policy.allowedCategories.includes(category)) {
      throw new HoldworkError('POLICY_CATEGORY', `Category "${category}" is not allowed for this operator`);
    }
    const since = this.now() - DAY;
    const operatorAgents = new Set([...this.agents.values()].filter((a) => a.operatorId === buyer.operatorId).map((a) => a.id));
    const recent = [...this.contracts.values()].filter(
      (c) => operatorAgents.has(c.buyerId) && c.createdAt >= since && c.id !== excludeContractId
        && c.state !== 'CANCELLED' && c.state !== 'EXPIRED',
    );
    if (policy.maxPerDay !== undefined && sellerId === undefined) {
      const spent = recent.reduce((s, c) => s + c.price, 0n);
      if (spent + price > policy.maxPerDay) {
        throw new HoldworkError('POLICY_MAX_PER_DAY', `Rolling 24h spend ${spent + price} exceeds max_per_day ${policy.maxPerDay}`);
      }
    }
    if (policy.maxPerCounterpartyPerDay !== undefined && sellerId !== undefined) {
      const withSeller = recent.filter((c) => c.sellerId === sellerId).reduce((s, c) => s + c.price, 0n);
      if (withSeller + price > policy.maxPerCounterpartyPerDay) {
        throw new HoldworkError(
          'POLICY_MAX_PER_COUNTERPARTY',
          `Rolling 24h spend with ${sellerId} ${withSeller + price} exceeds max_per_counterparty_per_day ${policy.maxPerCounterpartyPerDay}`,
        );
      }
    }
  }

  private sampleRateFor(c: Contract): number {
    const buyer = this.agent(c.buyerId);
    let rate = this.params.baseSampleRate;
    if (buyer.sampleRateOverride !== undefined) rate = Math.max(rate, buyer.sampleRateOverride);
    if (buyer.buyer.calibration < this.params.poorCalibrationThreshold) rate = Math.max(rate, this.params.elevatedSampleRate);
    const pair = this.pairs.get(pairKey(c.buyerId, c.sellerId!));
    if (pair) rate = Math.max(rate, pair.sampleRate);
    return Math.min(1, rate);
  }

  private updatePair(c: Contract, claim: number, network: number): void {
    const key = pairKey(c.buyerId, c.sellerId!);
    const pair = this.pairs.get(key) ?? {
      buyerId: c.buyerId, sellerId: c.sellerId!, contracts: 0, claimSum: 0, networkSum: 0, sampled: 0,
      inflationEpochs: 0, sampleRate: this.params.baseSampleRate,
    };
    pair.contracts = [...this.contracts.values()].filter((x) => x.buyerId === c.buyerId && x.sellerId === c.sellerId).length;
    pair.claimSum += claim;
    pair.networkSum += network;
    pair.sampled += 1;
    const inflation = (pair.claimSum - pair.networkSum) / pair.sampled;
    if (inflation > this.params.pairInflationThreshold && pair.contracts >= this.params.minPairContracts) {
      pair.inflationEpochs += 1;
      pair.sampleRate = pair.inflationEpochs >= this.params.persistentInflationEpochs
        ? this.params.permanentSampleRate
        : this.params.elevatedSampleRate;
      this.log(c, 'PAIR_FLAGGED', undefined, { inflation, sampleRate: pair.sampleRate });
    }
    this.pairs.set(key, pair);
  }

  private verifierPoolSize(c: Contract): number {
    const excluded = new Set([c.buyerOperatorId, c.sellerOperatorId]);
    return [...this.agents.values()].filter((a) => a.isVerifier && !excluded.has(a.operatorId)).length;
  }

  private expect(c: Contract, state: Contract['state']): void {
    if (c.state !== state) throw new HoldworkError('BAD_STATE', `Contract ${c.id} is ${c.state}, expected ${state}`);
  }

  private expectBuyer(c: Contract, id: string): void {
    if (c.buyerId !== id) throw new HoldworkError('NOT_BUYER', `${id} is not the buyer on ${c.id}`);
  }

  private expectSeller(c: Contract, id: string): void {
    if (c.sellerId !== id) throw new HoldworkError('NOT_SELLER', `${id} is not the seller on ${c.id}`);
  }

  private validateQuality(q: number, label = 'quality'): void {
    if (typeof q !== 'number' || Number.isNaN(q) || q < 0 || q > 1) {
      throw new HoldworkError('INVALID_QUALITY', `${label} must be a number in [0, 1]`);
    }
  }

  private validateCompute(r: ComputeReport): void {
    const ok = r && typeof r.model === 'string' && r.inputTokens >= 0 && r.outputTokens >= 0 && r.durationMs >= 0
      && r.toolCalls >= 0 && ['RUNTIME_METERED', 'SELF_REPORTED', 'ESTIMATED'].includes(r.measurement);
    if (!ok) throw new HoldworkError('INVALID_COMPUTE_REPORT', 'Compute report is missing fields or has negative values');
  }

  private log(c: Contract, type: string, by?: string, data?: Record<string, unknown>): void {
    const ev: ContractEvent = { at: this.now(), type, by, data };
    c.events.push(ev);
  }
}

export function pairKey(buyerId: string, sellerId: string): string {
  return `${buyerId}→${sellerId}`;
}
