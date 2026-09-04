/**
 * OpenRouter-backed scorer. Same contract as ClaudeScorer, over the OpenAI-compatible
 * chat completions API using plain fetch, so it runs unchanged on Node and Workers.
 *
 * Structured output is requested via response_format json_schema; the reply is validated with
 * zod regardless, and a malformed reply is retried once before yielding a zero-confidence score.
 */
import { z } from 'zod/v4';
import { checkSchema } from './schema-check.js';
import { buildScoringPrompt, SCORER_SYSTEM_PROMPT, finalizeScore, Judgement, type JudgementT } from './scoring-prompt.js';
import type { Score, Scorer, ScoringInput } from './types.js';

const JUDGEMENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['quality', 'confidence', 'criteria_met', 'criteria_missed', 'rationale'],
  properties: {
    quality: { type: 'number', minimum: 0, maximum: 1, description: 'Overall quality of the delivered output against the task, 0 to 1' },
    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How confident you are in the quality score, 0 to 1' },
    criteria_met: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria the output clearly satisfies' },
    criteria_missed: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria the output fails or does not address' },
    rationale: { type: 'string', description: 'Two to five sentences explaining the score, citing specifics from the output' },
  },
};

export interface OpenRouterScorerOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Sampling temperature. Non-zero so independent verifier calls on one model do not collapse to identical scores. */
  temperature?: number;
  fetchImpl?: typeof fetch;
  /** Attribution headers OpenRouter asks for. */
  referer?: string;
  title?: string;
}

export class OpenRouterScorer implements Scorer {
  readonly name: string;
  private readonly model: string;
  private readonly url: string;

  constructor(private readonly opts: OpenRouterScorerOptions) {
    this.model = opts.model ?? 'z-ai/glm-5.3-flash';
    this.url = `${(opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/chat/completions`;
    this.name = `openrouter:${this.model}`;
  }

  async score(input: ScoringInput): Promise<Score> {
    const schema = checkSchema(input.outputSchema, input.output);
    const { user, truncated } = buildScoringPrompt(input, schema);

    let judgement: JudgementT | null = null;
    let lastError = '';
    for (let attempt = 0; attempt < 3 && !judgement; attempt++) {
      try {
        judgement = await this.complete(user, attempt > 0 ? lastError : undefined);
      } catch (e) {
        lastError = String(e);
      }
    }

    if (!judgement) {
      return {
        quality: 0.5, confidence: 0, schemaValid: schema.valid, schemaErrors: schema.errors,
        criteriaMet: [], criteriaMissed: [], rationale: `Scorer returned no usable judgement: ${lastError}`, scorer: this.name,
      };
    }
    return finalizeScore(judgement, schema, truncated, this.name);
  }

  private async complete(user: string, repairHint?: string): Promise<JudgementT> {
    const f = this.opts.fetchImpl ?? fetch;
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: SCORER_SYSTEM_PROMPT + '\n\nRespond with a single JSON object matching the required schema and nothing else.' },
      { role: 'user', content: user },
    ];
    if (repairHint) messages.push({ role: 'user', content: `Your previous reply was not valid JSON for the schema (${repairHint}). Reply again with only the JSON object.` });

    const res = await f(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
        'http-referer': this.opts.referer ?? 'https://github.com/kfchai/holdwork',
        'x-title': this.opts.title ?? 'Holdwork verifier',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: this.opts.temperature ?? 0.4,
        // Reasoning models spend output tokens thinking before the JSON; leave room or the content arrives empty.
        max_tokens: 8000,
        messages,
        response_format: { type: 'json_schema', json_schema: { name: 'judgement', strict: true, schema: JUDGEMENT_JSON_SCHEMA } },
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      choices?: Array<{ finish_reason?: string; native_finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? 'OpenRouter error');
    const choice = body.choices?.[0];
    const msg = choice?.message;
    if (msg?.refusal) throw new Error(`model refused: ${msg.refusal}`);
    const text = (msg?.content ?? '').trim();
    if (!text) throw new Error(`empty content (finish_reason=${choice?.finish_reason ?? 'none'}, native=${choice?.native_finish_reason ?? 'none'})`);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error(`no JSON object in reply: ${text.slice(0, 120)}`);
    const jsonText = text.slice(start, end + 1);
    const parsed = Judgement.safeParse(JSON.parse(jsonText));
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    return parsed.data;
  }
}
