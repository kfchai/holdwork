import type { Micro } from './money.js';
import type { BuyerCalibration } from './calibration.js';

export type ContractState =
  | 'OPEN'
  | 'COMMITTED'
  | 'DELIVERED'
  | 'REVISION_REQUESTED'
  | 'ACCEPTED'
  | 'DISPUTED'
  | 'VERIFYING'
  | 'SETTLED'
  | 'CANCELLED'
  | 'EXPIRED';

export type MeasurementMethod = 'RUNTIME_METERED' | 'SELF_REPORTED' | 'ESTIMATED';

export interface ComputeReport {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  toolCalls: number;
  measurement: MeasurementMethod;
}

export interface SpendPolicy {
  maxPerTask?: Micro;
  maxPerDay?: Micro;
  maxPerCounterpartyPerDay?: Micro;
  allowedCategories?: string[];
}

export interface Agent {
  id: string;
  operatorId: string;
  name: string;
  skills: string[];
  isVerifier: boolean;
  reputation: number;
  verifierCalibration: number;
  buyer: BuyerCalibration;
  sampleRateOverride?: number;
  registeredAt: number;
}

export interface Operator {
  id: string;
  policy: SpendPolicy;
}

export interface Delivery {
  round: number;
  output: unknown;
  compute: ComputeReport;
  notes?: string;
  deliveredAt: number;
}

export interface RevisionRequest {
  round: number;
  qualityClaim: number;
  issues: string[];
  requestedAt: number;
  deadline: number;
}

export interface Attestation {
  verifierId: string;
  quality: number;
  confidence: number;
  submittedAt: number;
}

export interface VerificationRound {
  round: number;
  reason: 'DISPUTE' | 'CALIBRATION_SAMPLE' | 'ASSESSMENT_TIMEOUT' | 'REVISION_TIMEOUT' | 'COLLUSION_RERUN';
  verifierIds: string[];
  attestations: Attestation[];
  deadline: number;
  result?: { quality: number; lowConfidence: boolean; lowVariance: boolean };
}

export interface Settlement {
  quality: number;
  qualitySource: 'BUYER_CLAIM' | 'NETWORK' | 'DEFAULT';
  toSeller: Micro;
  fee: Micro;
  sellerNet: Micro;
  refund: Micro;
  stakeReturned: Micro;
  stakeForfeited: Micro;
  bondReturned: Micro;
  bondForfeited: Micro;
  verifierFeesPaid: Micro;
  verifierFeesPaidBy: 'SELLER_STAKE' | 'BUYER_BOND' | 'HOLDWORK' | 'NONE';
  settledAt: number;
  /** sha256 of the terms frozen at creation (criteriaHash on the contract), repeated on the receipt. */
  criteriaHash: string;
  /** sha256 of the delivery that was judged: final output, compute report, round number. */
  evidenceHash: string;
}

export interface ContractEvent {
  at: number;
  type: string;
  by?: string;
  data?: Record<string, unknown>;
}

export interface Contract {
  id: string;
  state: ContractState;
  buyerId: string;
  buyerOperatorId: string;
  sellerId?: string;
  sellerOperatorId?: string;
  title: string;
  description: string;
  category: string;
  outputSchema: unknown;
  acceptanceCriteria: string;
  price: Micro;
  stake: Micro;
  bond: Micro;
  fullPayQuality: number;
  zeroPayQuality: number;
  /**
   * sha256 over the terms frozen at creation: title, description, category, acceptance criteria,
   * output schema, payout thresholds, offer deadline, delivery window. Immutable; nothing after
   * creation can change what "done" meant.
   */
  criteriaHash: string;
  createdAt: number;
  offerDeadline: number;
  deliveryWindowMs: number;
  deliveryDeadline?: number;
  assessmentDeadline?: number;
  deliveries: Delivery[];
  revisions: RevisionRequest[];
  buyerClaim?: number;
  disputeReason?: string;
  verification: VerificationRound[];
  calibrationSample?: { sampled: boolean; rate: number; completed: boolean; networkQuality?: number; delta?: number };
  settlement?: Settlement;
  events: ContractEvent[];
}

export interface PairMetrics {
  buyerId: string;
  sellerId: string;
  contracts: number;
  claimSum: number;
  networkSum: number;
  sampled: number;
  inflationEpochs: number;
  sampleRate: number;
}

export class HoldworkError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HoldworkError';
  }
}
