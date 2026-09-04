/**
 * Live dispute on the deployed endpoint: register a model-verifier panel if missing, deliver a
 * deliberately incomplete piece of work, dispute it, and wait for the background verifiers to settle.
 */
import { readFileSync, existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const url = process.env.HOLDWORK_URL ?? 'https://holdwork.cortexum.ai';
const token = process.env.HOLDWORK_TOKEN!;
const headers = { authorization: `Bearer ${token}` };

const client = new Client({ name: 'live-dispute', version: '0.0.1' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers } }));

async function call(name: string, args: Record<string, unknown>, tolerate?: string) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
  if (res.isError) {
    if (tolerate && text.includes(tolerate)) return null;
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

// Verifier panel: ids must match the Worker's HOLDWORK_AUTO_VERIFIERS secret.
for (let i = 1; i <= 3; i++) {
  await call('register_agent', { id: `verifier-glm-${i}`, operatorId: `holdwork-verifiers-${i}`, name: `GLM verifier ${i}`, isVerifier: true }, 'AGENT_EXISTS');
}

const run = Date.now().toString(36);
const buyer = `buyer-${run}`, seller = `seller-${run}`;
await call('register_agent', { id: buyer, operatorId: `acme-${run}`, name: 'Acme buyer' });
await call('register_agent', { id: seller, operatorId: `vendor-${run}`, name: 'Vendor seller' });
await call('faucet', { agentId: buyer, amount: '50' });
await call('faucet', { agentId: seller, amount: '5' });

const task = await call('create_task', {
  buyerId: buyer, title: 'Summarise three quarterly filings', category: 'research', price: '20',
  description: 'For each of ACME, BOLT and CRANE Q2 filings, give a one-paragraph summary of revenue trend and one stated risk, with a page citation for each fact.',
  acceptanceCriteria: 'All three companies covered. Each summary has a revenue statement, one risk, and page citations.',
  outputSchema: {
    type: 'object', required: ['summaries'],
    properties: { summaries: { type: 'array', minItems: 3, items: { type: 'object', required: ['company', 'revenue', 'risk', 'citations'], properties: { company: { type: 'string' }, revenue: { type: 'string' }, risk: { type: 'string' }, citations: { type: 'array', minItems: 1, items: { type: 'string' } } } } } },
  },
});
await call('commit', { contractId: task.id, sellerId: seller });
await call('deliver', {
  contractId: task.id, sellerId: seller,
  output: { summaries: [
    { company: 'ACME', revenue: 'Revenue rose 12% to 4.1bn.', risk: 'Customer concentration.', citations: ['p.14'] },
    { company: 'BOLT', revenue: 'Revenue flat at 890m.', risk: 'Single-fab supply chain.', citations: ['p.7'] },
  ] },
  compute: { model: 'some-agent', inputTokens: 9000, outputTokens: 700, durationMs: 15000, toolCalls: 3, measurement: 'SELF_REPORTED' },
});
const t0 = Date.now();
const disputed = await call('dispute', { contractId: task.id, buyerId: buyer, qualityClaim: 0.4, reason: 'CRANE is missing entirely' });
console.log(`disputed ${task.id} in ${Date.now() - t0}ms; state ${disputed.state}; verifiers ${disputed.verification[0].verifiers.join(', ')}`);
console.log('buyer balance after bond:', (await call('get_agent', { agentId: buyer })).balance);

// Wait for the background alarm to score and settle.
let view = disputed;
for (let i = 0; i < 40 && view.state !== 'SETTLED'; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  view = await call('get_contract', { contractId: task.id });
  process.stdout.write(`  t+${Math.round((Date.now() - t0) / 1000)}s state=${view.state} rounds=${view.verification.length} attestations=${view.verification.at(-1).attestations}\n`);
}

console.log('\nfinal state:', view.state);
for (const r of view.verification) console.log(`round ${r.round} (${r.reason}) result:`, r.result);
for (const e of view.events.filter((e: { type: string }) => e.type === 'AUTO_ATTESTED')) {
  console.log(`\n${e.by} via ${e.data.scorer}: schemaValid=${e.data.schemaValid}\n  missed: ${(e.data.criteriaMissed ?? []).join(' | ')}\n  ${e.data.rationale}`);
}
console.log('\nsettlement:', view.settlement);
console.log('buyer:', (await call('get_agent', { agentId: buyer })).balance, '| seller:', (await call('get_agent', { agentId: seller })).balance);
for (let i = 1; i <= 3; i++) console.log(`verifier-glm-${i}:`, (await call('get_agent', { agentId: `verifier-glm-${i}` })).balance);
await client.close();
