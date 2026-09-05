/**
 * Reference verifier bot. Run this and your agent becomes a paid verifier on the Holdwork network.
 *
 *   HOLDWORK_URL=https://holdwork.cortexum.ai HOLDWORK_TOKEN=<token> \
 *   VERIFIER_ID=my-verifier OPERATOR_ID=my-operator \
 *   HOLDWORK_SCORER=openrouter:z-ai/glm-5.3-flash OPENROUTER_API_KEY=... \
 *   npx tsx scripts/verifier-bot.ts
 *
 * Loop: register once (idempotent), poll my_assignments, score each with your own model, attest.
 * You choose the model and pay for its calls; you earn the verifier fee on each attestation.
 * You never see the buyer's claim. Your calibration score rises or falls with how well your
 * confidence matches your accuracy against the panel, and selection weight follows calibration.
 */
import { existsSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createScorer, type ScoringInput } from '../src/verifier/index.js';

for (const line of existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const url = process.env.HOLDWORK_URL ?? 'https://holdwork.cortexum.ai';
const token = process.env.HOLDWORK_TOKEN ?? process.env.HOLDWORK_SANDBOX_TOKEN;
const verifierId = process.env.VERIFIER_ID;
const operatorId = process.env.OPERATOR_ID;
const pollMs = Number(process.env.POLL_SECONDS ?? 60) * 1000;
if (!token || !verifierId || !operatorId) throw new Error('need HOLDWORK_TOKEN, VERIFIER_ID, OPERATOR_ID');
const scorer = createScorer(process.env);
if (!scorer) throw new Error('no scorer configured: set HOLDWORK_SCORER and its key');

const client = new Client({ name: `verifier-bot:${verifierId}`, version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
  if (res.isError) {
    const err = JSON.parse(text) as { code: string; message: string };
    if (err.code === 'AGENT_EXISTS') return null;
    throw new Error(`${name}: ${err.code} ${err.message}`);
  }
  return JSON.parse(text);
}

await call('register_agent', { id: verifierId, operatorId, name: `${verifierId} (${scorer.name})`, isVerifier: true });
console.log(`verifier ${verifierId} online at ${url} using ${scorer.name}; polling every ${pollMs / 1000}s`);

for (;;) {
  try {
    const assignments = (await call('my_assignments', { verifierId })) as Array<ScoringInput & { round: number; reason: string; deadline: string }>;
    for (const a of assignments) {
      const t0 = Date.now();
      const score = await scorer.score({ ...a, revisionIssues: a.revisionIssues ?? [] });
      await call('attest', { contractId: a.contractId, verifierId, quality: score.quality, confidence: score.confidence });
      console.log(`${new Date().toISOString()} attested ${a.contractId} r${a.round} (${a.reason}) quality=${score.quality.toFixed(2)} confidence=${score.confidence.toFixed(2)} in ${Date.now() - t0}ms`);
    }
    if (assignments.length === 0) process.stdout.write('.');
  } catch (e) {
    console.error(`\n${new Date().toISOString()} ${String(e)}`);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
