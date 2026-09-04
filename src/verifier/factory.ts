/**
 * Build a scorer from one config string so servers stay provider-agnostic.
 *
 *   HOLDWORK_SCORER = "openrouter:z-ai/glm-5.3-flash"   needs OPENROUTER_API_KEY
 *   HOLDWORK_SCORER = "claude:claude-opus-5"             needs ANTHROPIC_API_KEY
 *
 * Returns null when nothing usable is configured, so auto-verification simply stays off.
 */
import { ClaudeScorer } from './claude-scorer.js';
import { OpenRouterScorer } from './openrouter-scorer.js';
import type { Scorer } from './types.js';

export interface ScorerEnv {
  HOLDWORK_SCORER?: string;
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

export function createScorer(env: ScorerEnv): Scorer | null {
  const spec = env.HOLDWORK_SCORER?.trim();
  if (spec) {
    const idx = spec.indexOf(':');
    const provider = idx === -1 ? spec : spec.slice(0, idx);
    const model = idx === -1 ? undefined : spec.slice(idx + 1) || undefined;
    if (provider === 'openrouter') {
      if (!env.OPENROUTER_API_KEY) throw new Error('HOLDWORK_SCORER is openrouter but OPENROUTER_API_KEY is not set');
      return new OpenRouterScorer({ apiKey: env.OPENROUTER_API_KEY, model });
    }
    if (provider === 'claude') {
      if (!env.ANTHROPIC_API_KEY) throw new Error('HOLDWORK_SCORER is claude but ANTHROPIC_API_KEY is not set');
      return new ClaudeScorer({ apiKey: env.ANTHROPIC_API_KEY, model });
    }
    throw new Error(`Unknown scorer provider "${provider}" in HOLDWORK_SCORER`);
  }
  // No explicit spec: pick whichever key exists.
  if (env.OPENROUTER_API_KEY) return new OpenRouterScorer({ apiKey: env.OPENROUTER_API_KEY });
  if (env.ANTHROPIC_API_KEY) return new ClaudeScorer({ apiKey: env.ANTHROPIC_API_KEY });
  return null;
}
