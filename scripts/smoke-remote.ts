/**
 * Remote smoke test: connect to the deployed Worker over Streamable HTTP with the bearer token
 * from .env, run a full contract, and print the settlement. Uses unique agent ids per run so it
 * can be re-run against live state.
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
const token = process.env.HOLDWORK_TOKEN;
if (!token) throw new Error('HOLDWORK_TOKEN missing (set in .env or the environment)');

const transport = new StreamableHTTPClientTransport(new URL('/mcp', url), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'smoke-remote', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log(`connected to ${url}, tools: ${tools.tools.length}`);

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

const run = Date.now().toString(36);
const buyer = `buyer-${run}`, seller = `seller-${run}`;
await call('register_agent', { id: buyer, operatorId: `acme-${run}`, name: 'Acme buyer' });
await call('register_agent', { id: seller, operatorId: `vendor-${run}`, name: 'Vendor seller', skills: ['research'] });
await call('faucet', { agentId: buyer, amount: '50' });
await call('faucet', { agentId: seller, amount: '5' });
await call('set_spend_policy', { operatorId: `acme-${run}`, maxPerTask: '20', allowedCategories: ['research'] });

const task = await call('create_task', {
  buyerId: buyer, title: 'Summarise three 10-K filings', category: 'research', price: '12.5',
  description: 'One page each, cite page numbers', acceptanceCriteria: 'All three covered, citations present',
});
console.log('created', task.id, task.state);
await call('commit', { contractId: task.id, sellerId: seller });
await call('deliver', {
  contractId: task.id, sellerId: seller, output: { summaries: 3, citations: 41 },
  compute: { model: 'claude-sonnet-5', inputTokens: 18000, outputTokens: 2600, durationMs: 22000, toolCalls: 6, measurement: 'RUNTIME_METERED' },
});
const settled = await call('accept', { contractId: task.id, buyerId: buyer, qualityClaim: 0.9 });
console.log('state:', settled.state, '| sellerNet', settled.settlement.sellerNet, '| fee', settled.settlement.fee, '| sampled', settled.calibrationSample?.sampled);

// Persistence: read it back on a fresh session.
await client.close();
const client2 = new Client({ name: 'smoke-remote-2', version: '0.0.1' });
await client2.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const again = await client2.callTool({ name: 'get_contract', arguments: { contractId: task.id } });
const view = JSON.parse((again.content as Array<{ text: string }>)[0].text);
console.log('read back on new session:', view.state, view.settlement?.sellerNet);
await client2.close();

// Auth: a bad token must be rejected.
const bad = await fetch(new URL('/mcp', url), { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
console.log('bad token status:', bad.status);
console.log('remote smoke OK');
