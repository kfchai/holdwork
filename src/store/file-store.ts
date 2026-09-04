/**
 * Poor man's database: the whole engine state in one JSON file.
 * bigint is encoded as { "$micro": "123" } so micro-USDC survives the round trip.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { HoldworkEngine, Ledger, type Agent, type Contract } from '../core/index.js';

export function serialize(engine: HoldworkEngine): string {
  return JSON.stringify(
    {
      version: 1,
      ledger: engine.ledger.snapshot(),
      agents: [...engine.agents.values()],
      operators: [...engine.operators.values()],
      contracts: [...engine.contracts.values()],
      pairs: [...engine.pairs.values()],
    },
    (_k, v) => (typeof v === 'bigint' ? { $micro: v.toString() } : v),
    2,
  );
}

function revive(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && '$micro' in (v as Record<string, unknown>)) {
    return BigInt((v as { $micro: string }).$micro);
  }
  return v;
}

export function loadEngine(path: string, networkKey: string): HoldworkEngine {
  if (!existsSync(path)) return new HoldworkEngine({ networkKey });
  const raw = JSON.parse(readFileSync(path, 'utf8'), revive);
  const engine = new HoldworkEngine({ networkKey, ledger: Ledger.fromSnapshot(raw.ledger) });
  for (const a of raw.agents as Agent[]) engine.agents.set(a.id, a);
  for (const o of raw.operators) engine.operators.set(o.id, o);
  for (const c of raw.contracts as Contract[]) engine.contracts.set(c.id, c);
  for (const p of raw.pairs) engine.pairs.set(`${p.buyerId}→${p.sellerId}`, p);
  return engine;
}

/** Atomic-ish save: write a temp file then rename over the target. */
export function saveEngine(path: string, engine: HoldworkEngine): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serialize(engine));
  renameSync(tmp, path);
}
