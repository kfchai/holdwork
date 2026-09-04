import { usdc, type Micro } from './money.js';

const HOUR = 60 * 60 * 1000;

export interface Params {
  feeBps: number;
  minFee: Micro;
  sellerStakeBps: number;
  minStake: Micro;
  disputeBondBps: number;
  minBond: Micro;
  verifierFee: Micro;
  verifiersPerDispute: number;
  baseSampleRate: number;
  elevatedSampleRate: number;
  permanentSampleRate: number;
  poorCalibrationThreshold: number;
  calibrationTolerance: number;
  calibrationAlpha: number;
  reputationAlpha: number;
  initialCalibration: number;
  initialReputation: number;
  nonDeliveryPenalty: number;
  defaultFullPayQuality: number;
  defaultZeroPayQuality: number;
  assessmentWindowMs: number;
  revisionWindowMs: number;
  verificationWindowMs: number;
  maxRevisionRounds: number;
  maxRevisionIssues: number;
  minRoundVariance: number;
  pairInflationThreshold: number;
  minPairContracts: number;
  persistentInflationEpochs: number;
}

export const DEFAULT_PARAMS: Params = {
  feeBps: 100,
  minFee: usdc('0.05'),
  sellerStakeBps: 500,
  minStake: usdc('0.10'),
  disputeBondBps: 1000,
  minBond: usdc('0.10'),
  verifierFee: usdc('0.05'),
  verifiersPerDispute: 3,
  baseSampleRate: 0.1,
  elevatedSampleRate: 0.5,
  permanentSampleRate: 1.0,
  poorCalibrationThreshold: 0.5,
  calibrationTolerance: 0.1,
  calibrationAlpha: 0.1,
  reputationAlpha: 0.1,
  initialCalibration: 0.7,
  initialReputation: 0.5,
  nonDeliveryPenalty: 0.05,
  defaultFullPayQuality: 0.8,
  defaultZeroPayQuality: 0.4,
  assessmentWindowMs: 24 * HOUR,
  revisionWindowMs: 48 * HOUR,
  verificationWindowMs: 24 * HOUR,
  maxRevisionRounds: 3,
  maxRevisionIssues: 20,
  // Flag a round only when scores are near-identical (std dev under ~0.02). Tok's 0.01 fired on honest rounds.
  minRoundVariance: 0.0005,
  pairInflationThreshold: 0.15,
  minPairContracts: 5,
  persistentInflationEpochs: 3,
};
