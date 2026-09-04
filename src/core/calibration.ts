export interface AttestationInput {
  verifierId: string;
  quality: number;
  confidence: number;
  calibration: number;
}

export interface ConsensusResult {
  quality: number;
  lowConfidence: boolean;
  lowVariance: boolean;
  variance: number;
}

/** Calibration-adjusted, confidence-weighted consensus (Tok §7.5) with variance flag (§7.5.2). */
export function consensus(atts: AttestationInput[], minVariance: number): ConsensusResult {
  if (atts.length === 0) throw new Error('consensus requires at least one attestation');
  const effective = atts.map((a) => a.confidence * a.calibration);
  const total = effective.reduce((s, e) => s + e, 0);
  const mean = atts.reduce((s, a) => s + a.quality, 0) / atts.length;
  const variance = atts.reduce((s, a) => s + (a.quality - mean) ** 2, 0) / atts.length;
  const lowConfidence = total === 0;
  const quality = lowConfidence
    ? mean
    : atts.reduce((s, a, i) => s + a.quality * effective[i], 0) / total;
  return {
    quality: clamp01(quality),
    lowConfidence,
    lowVariance: atts.length >= 2 && variance < minVariance,
    variance,
  };
}

/** Verifier calibration update (Tok §7.5.1). */
export function updateVerifierCalibration(
  old: number,
  quality: number,
  confidence: number,
  finalQuality: number,
  alpha: number,
): number {
  const accuracy = 1 - Math.abs(quality - finalQuality);
  const error = Math.abs(confidence - accuracy);
  return clamp01((1 - alpha) * old + alpha * (1 - error));
}

export interface BuyerCalibration {
  calibration: number;
  bias: number;
  sampledCount: number;
}

/** Buyer calibration update (Tok §7.9.3). Returns new profile and the absolute delta. */
export function updateBuyerCalibration(
  profile: BuyerCalibration,
  claim: number,
  networkQuality: number,
  alpha: number,
): { profile: BuyerCalibration; delta: number } {
  const delta = Math.abs(claim - networkQuality);
  const accuracy = 1 - delta;
  return {
    profile: {
      calibration: clamp01((1 - alpha) * profile.calibration + alpha * accuracy),
      bias: (1 - alpha) * profile.bias + alpha * (claim - networkQuality),
      sampledCount: profile.sampledCount + 1,
    },
    delta,
  };
}

export function ewma(old: number, sample: number, alpha: number): number {
  return clamp01((1 - alpha) * old + alpha * sample);
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
