/**
 * Claude-backed scorer via the Anthropic SDK with structured outputs.
 * Never sees the buyer's claim or any other verifier's score.
 *
 * Refusals are not routed to a fallback model on purpose: a scorer that declines to judge a
 * piece of work should produce a low-confidence score so the round can escalate, not be
 * silently answered by a different model.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { checkSchema } from './schema-check.js';
import { buildScoringPrompt, SCORER_SYSTEM_PROMPT, finalizeScore, Judgement } from './scoring-prompt.js';
import type { Score, Scorer, ScoringInput } from './types.js';

export class ClaudeScorer implements Scorer {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { client?: Anthropic; model?: string; apiKey?: string } = {}) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : undefined);
    this.model = opts.model ?? 'claude-opus-5';
    this.name = `claude:${this.model}`;
  }

  async score(input: ScoringInput): Promise<Score> {
    const schema = checkSchema(input.outputSchema, input.output);
    const { user, truncated } = buildScoringPrompt(input, schema);

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: zodOutputFormat(Judgement) },
      system: SCORER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
    });

    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return {
        quality: 0.5, confidence: 0, schemaValid: schema.valid, schemaErrors: schema.errors,
        criteriaMet: [], criteriaMissed: [],
        rationale: response.stop_reason === 'refusal'
          ? `Scorer declined to assess this output (${response.stop_details?.category ?? 'unspecified'}).`
          : 'Scorer returned no parseable judgement.',
        scorer: this.name,
      };
    }
    return finalizeScore(response.parsed_output, schema, truncated, this.name);
  }
}
