import { describe, it, expect } from 'vitest';
import { usdc, fmt, bps, scale } from '../src/core/money.js';
import { computePayout, releaseRatio } from '../src/core/payout.js';
import { DEFAULT_PARAMS } from '../src/core/params.js';
import { consensus, updateVerifierCalibration } from '../src/core/calibration.js';
import { selectVerifiers, shouldSample, weightedSampleWithoutReplacement, seededRng } from '../src/core/sampling.js';

describe('money', () => {
  it('parses and formats micro-USDC exactly', () => {
    expect(usdc('1')).toBe(1_000_000n);
    expect(usdc('0.05')).toBe(50_000n);
    expect(usdc('12.345678')).toBe(12_345_678n);
    expect(() => usdc('1.2345678')).toThrow();
    expect(fmt(12_345_678n)).toBe('12.345678');
    expect(fmt(usdc(20))).toBe('20');
    expect(bps(usdc(20), 100)).toBe(usdc('0.20'));
    expect(scale(usdc(10), 0.5)).toBe(usdc(5));
  });
});

describe('payout', () => {
  it('maps quality to release ratio linearly between thresholds', () => {
    expect(releaseRatio(0.9, 0.8, 0.4)).toBe(1);
    expect(releaseRatio(0.8, 0.8, 0.4)).toBe(1);
    expect(releaseRatio(0.6, 0.8, 0.4)).toBeCloseTo(0.5);
    expect(releaseRatio(0.39, 0.8, 0.4)).toBe(0);
  });
  it('applies min fee and never exceeds the released amount', () => {
    const p = computePayout(usdc(1), 0.45, 0.8, 0.4, DEFAULT_PARAMS); // ratio .125 → 0.125 USDC
    expect(p.toSeller).toBe(usdc('0.125'));
    expect(p.fee).toBe(usdc('0.05'));
    expect(p.sellerNet).toBe(usdc('0.075'));
    expect(p.refund).toBe(usdc('0.875'));
    const tiny = computePayout(usdc('0.02'), 1, 0.8, 0.4, DEFAULT_PARAMS);
    expect(tiny.fee).toBe(usdc('0.02'));
    expect(tiny.sellerNet).toBe(0n);
  });
});

describe('consensus', () => {
  it('weights by confidence × calibration', () => {
    const r = consensus([
      { verifierId: 'a', quality: 0.9, confidence: 1, calibration: 1 },
      { verifierId: 'b', quality: 0.5, confidence: 1, calibration: 0 },
    ], 0.0005);
    expect(r.quality).toBe(0.9);
    expect(r.lowVariance).toBe(false);
  });
  it('falls back to the mean when all effective confidence is zero', () => {
    const r = consensus([
      { verifierId: 'a', quality: 0.8, confidence: 0, calibration: 1 },
      { verifierId: 'b', quality: 0.4, confidence: 0, calibration: 1 },
    ], 0.0005);
    expect(r.quality).toBeCloseTo(0.6);
    expect(r.lowConfidence).toBe(true);
  });
  it('flags low variance', () => {
    const r = consensus([
      { verifierId: 'a', quality: 0.80, confidence: 1, calibration: 1 },
      { verifierId: 'b', quality: 0.81, confidence: 1, calibration: 1 },
      { verifierId: 'c', quality: 0.80, confidence: 1, calibration: 1 },
    ], 0.0005);
    expect(r.lowVariance).toBe(true);
    // honest spread is not flagged
    const honest = consensus([
      { verifierId: 'a', quality: 0.4, confidence: 1, calibration: 1 },
      { verifierId: 'b', quality: 0.5, confidence: 1, calibration: 1 },
      { verifierId: 'c', quality: 0.6, confidence: 1, calibration: 1 },
    ], 0.0005);
    expect(honest.lowVariance).toBe(false);
  });
  it('lowers calibration for an overconfident verifier', () => {
    // claims full confidence, misses consensus by 0.5 → accuracy 0.5, error 0.5
    const c = updateVerifierCalibration(0.7, 0.3, 1.0, 0.8, 0.1);
    expect(c).toBeCloseTo(0.68);
    // well-calibrated: confidence matches accuracy, calibration rises toward 1
    expect(updateVerifierCalibration(0.7, 0.75, 0.95, 0.8, 0.1)).toBeGreaterThan(0.7);
  });
});

describe('sampling', () => {
  it('is deterministic for the same inputs and differs across keys', () => {
    const a = shouldSample('k1', 'c1', 'b1', 1, 0.1);
    expect(shouldSample('k1', 'c1', 'b1', 1, 0.1)).toBe(a);
    let diff = 0;
    for (let i = 0; i < 200; i++) if (shouldSample('k1', `c${i}`, 'b', 1, 0.5) !== shouldSample('k2', `c${i}`, 'b', 1, 0.5)) diff++;
    expect(diff).toBeGreaterThan(50);
  });
  it('selects verifiers deterministically and without duplicates', () => {
    const cands = ['v1', 'v2', 'v3', 'v4', 'v5'].map((id, i) => ({ id, weight: 0.5 + i * 0.1 }));
    const a = selectVerifiers('k', 'c', 1, cands, 3);
    const b = selectVerifiers('k', 'c', 1, [...cands].reverse(), 3);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
    expect(selectVerifiers('k', 'c', 2, cands, 3)).not.toEqual(a);
  });
  it('weighted sampling favours heavier items', () => {
    const rng = seededRng(42n);
    let heavy = 0;
    for (let i = 0; i < 1000; i++) if (weightedSampleWithoutReplacement(['h', 'l'], [9, 1], 1, rng)[0] === 'h') heavy++;
    expect(heavy).toBeGreaterThan(850);
  });
});
