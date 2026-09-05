/**
 * Testnet pilot: drive a real on-chain contract through the hosted real-money endpoint.
 *
 *   npx tsx scripts/testnet-pilot.ts [accept|dispute]     (default accept)
 *
 * Creates buyer and seller wallets on first run (.wallet/pilot-buyer.json, .wallet/pilot-seller.json),
 * funds them with gas and USDC from the arbiter wallet, registers them with the endpoint, then:
 *   prepare_open  -> buyer signs approve + open      -> wait for the indexer to see Opened
 *   prepare_commit -> seller signs approve + commit  -> wait for Committed
 *   deliver (off-chain)
 *   accept:  prepare_accept -> buyer signs accept    -> wait for settlement mirror
 *   dispute: prepare_dispute -> buyer signs approve + dispute -> verifiers score -> arbiter settles on-chain
 * Prints balances before and after, and the settlement receipt.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, formatUnits, parseUnits, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ERC20_ABI } from '../src/chain/index.js';

for (const line of existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const MODE = (process.argv[2] ?? 'accept') as 'accept' | 'dispute';
const URL_ = process.env.HOLDWORK_TESTNET_URL ?? 'https://testnet.holdwork.cortexum.ai';
const TOKEN = process.env.HOLDWORK_TESTNET_TOKEN;
if (!TOKEN) throw new Error('HOLDWORK_TESTNET_TOKEN missing from .env');
const dep = JSON.parse(readFileSync('deployments/base-sepolia.json', 'utf8')) as { address: Address; usdc: Address };

const pub = createPublicClient({ chain: baseSepolia, transport: http() });
const loadOrCreate = (path: string) => {
  if (!existsSync(path)) writeFileSync(path, JSON.stringify({ privateKey: generatePrivateKey() }, null, 2), { mode: 0o600 });
  const pk = (JSON.parse(readFileSync(path, 'utf8')) as { privateKey: Hex }).privateKey;
  return privateKeyToAccount(pk);
};
const arbiter = loadOrCreate('.wallet/arbiter-testnet.json');
const buyer = loadOrCreate('.wallet/pilot-buyer.json');
const seller = loadOrCreate('.wallet/pilot-seller.json');
const wallet = (a: typeof arbiter) => createWalletClient({ chain: baseSepolia, account: a, transport: http() });

const usdcBal = async (a: Address) => pub.readContract({ address: dep.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] });
const show = async (label: string) => {
  const [ab, bb, sb, ae, be, se] = await Promise.all([usdcBal(arbiter.address), usdcBal(buyer.address), usdcBal(seller.address), pub.getBalance({ address: arbiter.address }), pub.getBalance({ address: buyer.address }), pub.getBalance({ address: seller.address })]);
  console.log(`${label}: arbiter ${formatUnits(ab, 6)} USDC/${formatUnits(ae, 18).slice(0, 8)} ETH | buyer ${formatUnits(bb, 6)}/${formatUnits(be, 18).slice(0, 8)} | seller ${formatUnits(sb, 6)}/${formatUnits(se, 18).slice(0, 8)}`);
};

// ───────── fund pilot wallets from the arbiter (gas + USDC) ─────────
async function ensureFunded(a: Address, minEth: bigint, minUsdc: bigint) {
  const w = wallet(arbiter);
  if ((await pub.getBalance({ address: a })) < minEth) {
    const h = await w.sendTransaction({ to: a, value: minEth });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`funded ${a} with gas: ${h}`);
  }
  if ((await usdcBal(a)) < minUsdc) {
    const h = await w.writeContract({ address: dep.usdc, abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'transfer', args: [a, minUsdc] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`funded ${a} with USDC: ${h}`);
  }
}

await show('start');
await ensureFunded(buyer.address, parseUnits('0.0003', 18), parseUnits('3', 6));
await ensureFunded(seller.address, parseUnits('0.0003', 18), parseUnits('0.5', 6));
await show('after funding');

// ───────── MCP ─────────
const client = new Client({ name: 'testnet-pilot', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', URL_), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
async function call(name: string, args: Record<string, unknown>, tolerate?: string) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
  if (res.isError) { if (tolerate && text.includes(tolerate)) return null; throw new Error(`${name} failed: ${text}`); }
  return JSON.parse(text);
}
type Tx = { to: Address; data: Hex; description: string };
async function sign(a: typeof arbiter, txs: Tx[]) {
  for (const t of txs) {
    const h = await wallet(a).sendTransaction({ to: t.to, data: t.data });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  ${r.status} ${t.description.slice(0, 70)} → ${h}`);
    if (r.status !== 'success') throw new Error(`tx reverted: ${h}`);
  }
}
async function waitState(id: string, want: string[], maxSec = 240) {
  for (let i = 0; i < maxSec / 10; i++) {
    const v = await call('get_contract', { contractId: id });
    if (want.includes(v.state)) return v;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`timeout waiting for ${want.join('|')} on ${id}`);
}

const info = await call('chain_info', {});
console.log('endpoint mode:', info.chainId, info.escrow);
const run = Date.now().toString(36);
await call('register_agent', { id: `pilot-buyer`, operatorId: 'pilot-acme', name: 'Pilot buyer', wallet: buyer.address }, 'AGENT_EXISTS');
await call('register_agent', { id: `pilot-seller`, operatorId: 'pilot-vendor', name: 'Pilot seller', wallet: seller.address }, 'AGENT_EXISTS');
for (let i = 1; i <= 3; i++) await call('register_agent', { id: `verifier-glm-${i}`, operatorId: `holdwork-verifiers-${i}`, name: `GLM verifier ${i}`, isVerifier: true }, 'AGENT_EXISTS');

const t0 = Date.now();
const prep = await call('prepare_open', {
  buyerId: 'pilot-buyer', title: `Pilot ${run}: summarise three filings`, category: 'research', price: '2',
  description: 'For ACME, BOLT and CRANE: one-paragraph revenue trend and one risk each, with page citations.',
  acceptanceCriteria: 'All three companies covered with citations.',
  outputSchema: { type: 'object', required: ['summaries'], properties: { summaries: { type: 'array', minItems: 3 } } },
  offerWindowHours: 2, deliveryWindowHours: 2,
});
console.log(`prepared ${prep.contractId} (${prep.state}); buyer signing ${prep.transactions.length} txs`);
await sign(buyer, prep.transactions);
let v = await waitState(prep.contractId, ['OPEN']);
console.log(`OPEN after ${Math.round((Date.now() - t0) / 1000)}s (indexer saw Opened)`);

const pc = await call('prepare_commit', { contractId: prep.contractId, sellerId: 'pilot-seller' });
await sign(seller, pc.transactions);
v = await waitState(prep.contractId, ['COMMITTED']);
console.log(`COMMITTED after ${Math.round((Date.now() - t0) / 1000)}s`);

const output = MODE === 'accept'
  ? { summaries: [{ company: 'ACME', revenue: 'up 12%', risk: 'concentration', citations: ['p.14'] }, { company: 'BOLT', revenue: 'flat', risk: 'single fab', citations: ['p.7'] }, { company: 'CRANE', revenue: 'down 6%', risk: 'covenants', citations: ['p.9'] }] }
  : { summaries: [{ company: 'ACME', revenue: 'up 12%', risk: 'concentration', citations: ['p.14'] }, { company: 'BOLT', revenue: 'flat', risk: 'single fab', citations: ['p.7'] }] };
await call('deliver', { contractId: prep.contractId, sellerId: 'pilot-seller', output, compute: { model: 'pilot', inputTokens: 1000, outputTokens: 300, durationMs: 5000, toolCalls: 1, measurement: 'SELF_REPORTED' } });

if (MODE === 'accept') {
  const pa = await call('prepare_accept', { contractId: prep.contractId, buyerId: 'pilot-buyer', qualityClaim: 0.9 });
  console.log(`buyer releases ${pa.toSeller} micro-USDC by its own signature`);
  await sign(buyer, pa.transactions);
} else {
  const pd = await call('prepare_dispute', { contractId: prep.contractId, buyerId: 'pilot-buyer', qualityClaim: 0.4, reason: 'CRANE missing' });
  await sign(buyer, pd.transactions);
}
v = await waitState(prep.contractId, ['SETTLED'], 600);
console.log(`SETTLED after ${Math.round((Date.now() - t0) / 1000)}s`);
console.log('settlement:', JSON.stringify(v.settlement, null, 2));
console.log('chain:', JSON.stringify(v.chain));
if (MODE === 'dispute') {
  for (let i = 0; i < 30 && !(await call('get_contract', { contractId: prep.contractId })).chain?.settled; i++) await new Promise((r) => setTimeout(r, 10_000));
  console.log('arbiter settlement on-chain:', JSON.stringify((await call('get_contract', { contractId: prep.contractId })).chain));
}
await show('end');
await client.close();
