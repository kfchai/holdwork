/**
 * End-to-end smoke test: spawn the MCP server as a client would, run a full contract
 * through it, and print the settlement. Uses a throwaway state file.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { rmSync } from 'node:fs';

const STATE = './.smoke-state.json';
rmSync(STATE, { force: true });

const transport = new StdioClientTransport({
  command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
  args: ['tsx', 'src/mcp/server.ts'],
  env: { ...process.env, HOLDWORK_STATE: STATE },
});
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

await call('register_agent', { id: 'acme-buyer', operatorId: 'acme', name: 'Acme procurement agent' });
await call('register_agent', { id: 'vendor-seller', operatorId: 'vendor', name: 'Research vendor agent', skills: ['research'] });
for (let i = 1; i <= 3; i++) await call('register_agent', { id: `verifier-${i}`, operatorId: `vco-${i}`, name: `Verifier ${i}`, isVerifier: true });
await call('faucet', { agentId: 'acme-buyer', amount: '50' });
await call('faucet', { agentId: 'vendor-seller', amount: '5' });
await call('set_spend_policy', { operatorId: 'acme', maxPerTask: '20', maxPerDay: '40', allowedCategories: ['research'] });

const task = await call('create_task', {
  buyerId: 'acme-buyer', title: 'Summarise three 10-K filings', category: 'research', price: '12.5',
  description: 'One page each, cite page numbers', acceptanceCriteria: 'All three covered, citations present',
});
console.log('created', task.id, task.state, 'price', task.price);

const open = await call('list_open_tasks', { category: 'research' });
console.log('open tasks:', open.length);

await call('commit', { contractId: task.id, sellerId: 'vendor-seller' });
await call('deliver', {
  contractId: task.id, sellerId: 'vendor-seller', output: { summaries: 3, citations: 41 },
  compute: { model: 'claude-sonnet-5', inputTokens: 18000, outputTokens: 2600, durationMs: 22000, toolCalls: 6, measurement: 'RUNTIME_METERED' },
});
const settled = await call('accept', { contractId: task.id, buyerId: 'acme-buyer', qualityClaim: 0.9 });
console.log('state:', settled.state);
console.log('settlement:', settled.settlement);
console.log('sampled for calibration:', settled.calibrationSample?.sampled);

const buyer = await call('get_agent', { agentId: 'acme-buyer' });
const seller = await call('get_agent', { agentId: 'vendor-seller' });
console.log('buyer balance', buyer.balance, '| seller balance', seller.balance, '| seller reputation', seller.reputation);

// Policy must refuse without locking anything.
try {
  await call('create_task', { buyerId: 'acme-buyer', title: 'x', description: 'x', category: 'design', price: '1' });
  console.log('POLICY FAILED TO BLOCK');
} catch (e) {
  console.log('policy blocked as expected:', String(e).split('failed: ')[1]);
}

await client.close();
rmSync(STATE, { force: true });
console.log('smoke OK');
