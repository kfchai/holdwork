import { createHmac } from 'node:crypto';

/** First 8 bytes of HMAC-SHA256(key, parts joined by '|') as an unsigned 64-bit integer. */
export function hmacUint64(key: string, ...parts: Array<string | number>): bigint {
  const digest = createHmac('sha256', key).update(parts.join('|')).digest();
  return digest.readBigUInt64BE(0);
}

/**
 * Deterministic calibration sampling decision (Tok §7.9.1).
 * Same contract + buyer + created_at always yields the same decision; the buyer cannot predict it
 * without the network key.
 */
export function shouldSample(
  networkKey: string,
  contractId: string,
  buyerId: string,
  createdAt: number,
  rate: number,
): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const v = Number(hmacUint64(networkKey, contractId, buyerId, createdAt, 'CALIBRATION_SAMPLE') % 10_000n);
  return v < Math.round(rate * 10_000);
}

/** xorshift64* seeded PRNG returning floats in [0,1). */
export function seededRng(seed: bigint): () => number {
  let s = seed === 0n ? 0x9e3779b97f4a7c15n : seed & 0xffffffffffffffffn;
  return () => {
    s ^= s >> 12n;
    s ^= (s << 25n) & 0xffffffffffffffffn;
    s ^= s >> 27n;
    s &= 0xffffffffffffffffn;
    const out = (s * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
    return Number(out >> 11n) / 2 ** 53;
  };
}

/** Weighted sampling without replacement. Zero or negative weights are treated as tiny positive. */
export function weightedSampleWithoutReplacement<T>(
  items: T[],
  weights: number[],
  k: number,
  rng: () => number,
): T[] {
  const pool = items.map((item, i) => ({ item, w: Math.max(weights[i] ?? 0, 1e-6) }));
  const out: T[] = [];
  while (out.length < k && pool.length > 0) {
    const total = pool.reduce((a, p) => a + p.w, 0);
    let r = rng() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    out.push(pool[idx].item);
    pool.splice(idx, 1);
  }
  return out;
}

/** Deterministic verifier selection seeded from the contract id and round (Tok §7.2). */
export function selectVerifiers(
  networkKey: string,
  contractId: string,
  round: number,
  candidates: Array<{ id: string; weight: number }>,
  k: number,
): string[] {
  const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const rng = seededRng(hmacUint64(networkKey, contractId, round, 'VERIFIER_SELECT'));
  return weightedSampleWithoutReplacement(
    sorted.map((c) => c.id),
    sorted.map((c) => c.weight),
    k,
    rng,
  );
}
