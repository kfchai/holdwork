/**
 * Model-backed scorer. Reads the task, criteria, schema and delivered output, and returns a
 * structured quality judgement. Never sees the buyer's claim or any other verifier's score.
 *
 * Refusals are not routed to a fallback model on purpose: a scorer that declines to judge a
 * piece of work should produce a low-confidence score so the round can escalate, not be
 * silently answered by a different model.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// The SDK's Zod helper is typed against Zod v4; zod 3.25+ ships v4 under this subpath.
import { z } from 'zod/v4';
import { checkSchema } from './schema-check.js';
import type { Score, Scorer, ScoringInput } from './types.js';

const Judgement = z.object({
  quality: z.number().min(0).max(1).describe('Overall quality of the delivered output against the task, 0 to 1'),
  confidence: z.number().min(0).max(1).describe('How confident you are in the quality score, 0 to 1'),
  criteria_met: z.array(z.string()).describe('Acceptance criteria that the output clearly satisfies'),
  criteria_missed: z.array(z.string()).describe('Acceptance criteria that the output fails or does not address'),
  rationale: z.string().describe('Two to five sentences explaining the score, citing specifics from the output'),
});

const SYSTEM = `You are an independent verifier for work delivered by one AI agent to another.
You are paid a fixed fee regardless of your verdict. You have no stake in either party.

Score the delivered output against the task description, the acceptance criteria, and the output schema.
Judge only what was asked. Do not reward extra material that was not requested, and do not penalise
brevity when the task was fully met. Treat fabricated citations, placeholder text, and silent scope
reduction as serious failures.

Scoring anchors for quality:
  0.95 to 1.00  Fully meets every criterion, no material defects.
  0.80 to 0.94  Meets the task; minor defects a buyer would accept without a revision.
  0.60 to 0.79  Usable but a buyer would reasonably ask for a revision.
  0.40 to 0.59  Substantial gaps; half or less of the value delivered.
  0.00 to 0.39  Wrong, missing, fabricated, or unusable.

Set confidence below 0.6 when the task is ambiguous, the output is too large to inspect fully,
or you cannot verify factual claims from the material given.`;

const MAX_OUTPUT_CHARS = 400_000;

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
    let outputText = typeof input.output === 'string' ? input.output : JSON.stringify(input.output, null, 2);
    let truncated = false;
    if (outputText.length > MAX_OUTPUT_CHARS) {
      // Not silent: the scorer is told, and confidence is capped below.
      outputText = outputText.slice(0, MAX_OUTPUT_CHARS) + `\n\n[TRUNCATED: ${outputText.length - MAX_OUTPUT_CHARS} more characters not shown]`;
      truncated = true;
    }

    const user = [
      `# Task\n${input.title}\n\n${input.description}`,
      `# Category\n${input.category}`,
      `# Acceptance criteria\n${input.acceptanceCriteria || '(none given; judge against the task description)'}`,
      `# Output schema\n${schema.applicable ? JSON.stringify(input.outputSchema, null, 2) : '(none given)'}`,
      `# Schema check (deterministic, already run)\n${
        !schema.applicable ? 'not applicable' : schema.valid ? 'PASS' : `FAIL\n${schema.errors.join('\n')}`
      }`,
      input.revisionIssues.length
        ? `# Issues the buyer raised in earlier revision rounds\n${input.revisionIssues.map((i) => `- ${i}`).join('\n')}`
        : '',
      `# Compute report from the seller\nmodel=${input.compute.model} input_tokens=${input.compute.inputTokens} output_tokens=${input.compute.outputTokens} duration_ms=${input.compute.durationMs} tool_calls=${input.compute.toolCalls} measurement=${input.compute.measurement}`,
      `# Delivered output\n${outputText}`,
    ].filter(Boolean).join('\n\n');

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: zodOutputFormat(Judgement) },
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
    });

    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return {
        quality: 0.5,
        confidence: 0,
        schemaValid: schema.valid,
        schemaErrors: schema.errors,
        criteriaMet: [],
        criteriaMissed: [],
        rationale: response.stop_reason === 'refusal'
          ? `Scorer declined to assess this output (${response.stop_details?.category ?? 'unspecified'}).`
          : 'Scorer returned no parseable judgement.',
        scorer: this.name,
      };
    }

    const j = response.parsed_output;
    // A failed schema check caps quality in the revision band: the buyer cannot consume it as-is.
    const quality = schema.applicable && !schema.valid ? Math.min(j.quality, 0.55) : j.quality;
    const confidence = truncated ? Math.min(j.confidence, 0.5) : j.confidence;

    return {
      quality,
      confidence,
      schemaValid: schema.valid,
      schemaErrors: schema.errors,
      criteriaMet: j.criteria_met,
      criteriaMissed: j.criteria_missed,
      rationale: j.rationale,
      scorer: this.name,
    };
  }
}
