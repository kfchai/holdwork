import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted recursively, so equal values hash equally regardless of construction order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** sha256 over canonical JSON, hex with 0x prefix so it can go straight into a bytes32 on-chain. */
export function canonicalHash(value: unknown): string {
  return '0x' + createHash('sha256').update(canonicalJson(value)).digest('hex');
}
