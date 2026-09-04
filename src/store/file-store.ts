/**
 * Poor man's database: the whole engine state in one JSON file.
 * bigint is encoded as { "$micro": "123" } so micro-USDC survives the round trip.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { HoldworkEngine } from '../core/index.js';
import { deserializeEngine, serializeEngine } from './serialize.js';

export function loadEngine(path: string, networkKey: string): HoldworkEngine {
  if (!existsSync(path)) return new HoldworkEngine({ networkKey });
  return deserializeEngine(readFileSync(path, 'utf8'), networkKey);
}

/** Atomic-ish save: write a temp file then rename over the target. */
export function saveEngine(path: string, engine: HoldworkEngine): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeEngine(engine));
  renameSync(tmp, path);
}
