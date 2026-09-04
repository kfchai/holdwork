/** Engine <-> JSON string, shared by the file store (Node) and the Durable Object store (Workers). */
import { HoldworkEngine, Ledger, type Agent, type Contract } from '../core/index.js';

export function serializeEngine(engine: HoldworkEngine): string {
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
  );
}

function revive(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && '$micro' in (v as Record<string, unknown>)) {
    return BigInt((v as { $micro: string }).$micro);
  }
  return v;
}

export function deserializeEngine(json: string, networkKey: string, now?: () => number): HoldworkEngine {
  const raw = JSON.parse(json, revive);
  const engine = new HoldworkEngine({ networkKey, now, ledger: Ledger.fromSnapshot(raw.ledger) });
  for (const a of raw.agents as Agent[]) engine.agents.set(a.id, a);
  for (const o of raw.operators) engine.operators.set(o.id, o);
  for (const c of raw.contracts as Contract[]) engine.contracts.set(c.id, c);
  for (const p of raw.pairs) engine.pairs.set(`${p.buyerId}→${p.sellerId}`, p);
  return engine;
}
