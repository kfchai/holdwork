#!/usr/bin/env node
/**
 * Holdwork MCP server (stdio). Any MCP client can register agents, create tasks,
 * commit, deliver, accept, dispute, and attest. Ledger mode: no real money.
 *
 * State persists to HOLDWORK_STATE (default ./holdwork-state.json) after every call.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HoldworkError, usdc, fmt, type Contract, type Agent } from '../core/index.js';
import { loadEngine, saveEngine } from '../store/file-store.js';
import { AutoVerifier, ClaudeScorer } from '../verifier/index.js';

const STATE_PATH = process.env.HOLDWORK_STATE ?? './holdwork-state.json';
const NETWORK_KEY = process.env.HOLDWORK_NETWORK_KEY ?? 'dev-network-key-change-me';
/** Comma-separated verifier agent ids this process attests for using the model scorer. */
const AUTO_VERIFIERS = (process.env.HOLDWORK_AUTO_VERIFIERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const engine = loadEngine(STATE_PATH, NETWORK_KEY);
const save = () => saveEngine(STATE_PATH, engine);

const autoVerifier = AUTO_VERIFIERS.length
  ? new AutoVerifier(engine, new ClaudeScorer({ model: process.env.HOLDWORK_SCORER_MODEL }), AUTO_VERIFIERS)
  : null;

/** After any state change, let model verifiers attest on rounds they were assigned to. */
async function autoVerify(): Promise<void> {
  if (!autoVerifier || autoVerifier.pending().length === 0) return;
  try {
    await autoVerifier.run();
  } catch (e) {
    // Scoring failure must never break the caller's operation; the round stays open for a retry.
    console.error(`[holdwork] auto-verify failed: ${String(e)}`);
  }
}

// ───────────── presentation ─────────────

function view(c: Contract) {
  return {
    id: c.id,
    state: c.state,
    title: c.title,
    category: c.category,
    buyer: c.buyerId,
    seller: c.sellerId ?? null,
    price: fmt(c.price),
    stake: fmt(c.stake),
    bond: fmt(c.bond),
    thresholds: { fullPay: c.fullPayQuality, zeroPay: c.zeroPayQuality },
    deadlines: {
      offer: new Date(c.offerDeadline).toISOString(),
      delivery: c.deliveryDeadline ? new Date(c.deliveryDeadline).toISOString() : null,
      assessment: c.assessmentDeadline ? new Date(c.assessmentDeadline).toISOString() : null,
    },
    deliveries: c.deliveries.length,
    revisions: c.revisions,
    buyerClaim: c.buyerClaim ?? null,
    verification: c.verification.map((r) => ({
      round: r.round, reason: r.reason, verifiers: r.verifierIds, attestations: r.attestations.length,
      deadline: new Date(r.deadline).toISOString(), result: r.result ?? null,
    })),
    calibrationSample: c.calibrationSample ?? null,
    settlement: c.settlement
      ? {
          quality: c.settlement.quality, source: c.settlement.qualitySource,
          toSeller: fmt(c.settlement.toSeller), fee: fmt(c.settlement.fee), sellerNet: fmt(c.settlement.sellerNet),
          refund: fmt(c.settlement.refund), stakeReturned: fmt(c.settlement.stakeReturned),
          bondReturned: fmt(c.settlement.bondReturned), bondForfeited: fmt(c.settlement.bondForfeited),
          verifierFeesPaid: fmt(c.settlement.verifierFeesPaid), verifierFeesPaidBy: c.settlement.verifierFeesPaidBy,
        }
      : null,
    latestOutput: c.deliveries.at(-1)?.output ?? null,
    events: c.events.slice(-12),
  };
}

function agentView(a: Agent) {
  return {
    id: a.id, operator: a.operatorId, name: a.name, skills: a.skills, isVerifier: a.isVerifier,
    reputation: +a.reputation.toFixed(3), verifierCalibration: +a.verifierCalibration.toFixed(3),
    buyerCalibration: +a.buyer.calibration.toFixed(3), buyerBias: +a.buyer.bias.toFixed(3),
    balance: fmt(engine.balance(a.id)),
  };
}

async function run<T>(fn: () => T) {
  try {
    const result = fn();
    save();
    await autoVerify();
    save();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const err = e instanceof HoldworkError ? { code: e.code, message: e.message } : { code: 'ERROR', message: String(e) };
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(err) }] };
  }
}

const quality = z.number().min(0).max(1);
const money = z.string().regex(/^\d+(\.\d{1,6})?$/, 'decimal USDC, up to 6 places');

// ───────────── tools ─────────────

const server = new McpServer({ name: 'holdwork', version: '0.1.0' });

server.tool(
  'register_agent',
  'Register an agent under an operator. Verifiers score disputed or sampled work for a fee.',
  { id: z.string().optional(), operatorId: z.string(), name: z.string(), skills: z.array(z.string()).optional(), isVerifier: z.boolean().optional() },
  (a) => run(() => agentView(engine.registerAgent(a))),
);

server.tool(
  'faucet',
  'Ledger mode only: credit an agent with test USDC.',
  { agentId: z.string(), amount: money },
  (a) => run(() => ({ agentId: a.agentId, balance: fmt(engine.faucet(a.agentId, usdc(a.amount))) })),
);

server.tool(
  'set_spend_policy',
  'Set an operator spend policy: caps per task, per rolling 24h, per counterparty per 24h, and allowed categories.',
  { operatorId: z.string(), maxPerTask: money.optional(), maxPerDay: money.optional(), maxPerCounterpartyPerDay: money.optional(), allowedCategories: z.array(z.string()).optional() },
  (a) => run(() => engine.setSpendPolicy(a.operatorId, {
    maxPerTask: a.maxPerTask ? usdc(a.maxPerTask) : undefined,
    maxPerDay: a.maxPerDay ? usdc(a.maxPerDay) : undefined,
    maxPerCounterpartyPerDay: a.maxPerCounterpartyPerDay ? usdc(a.maxPerCounterpartyPerDay) : undefined,
    allowedCategories: a.allowedCategories,
  }) && { operatorId: a.operatorId, policy: a }),
);

server.tool(
  'create_task',
  'Buyer creates a task and locks the price in escrow. Fails, without locking, if the operator spend policy is violated.',
  {
    buyerId: z.string(), title: z.string(), description: z.string(), category: z.string(),
    price: money, acceptanceCriteria: z.string().optional(), outputSchema: z.any().optional(),
    offerWindowHours: z.number().positive().optional(), deliveryWindowHours: z.number().positive().optional(),
    fullPayQuality: z.number().min(0.5).max(1).optional(), zeroPayQuality: z.number().min(0).max(1).optional(),
  },
  (a) => run(() => view(engine.createTask({
    ...a, price: usdc(a.price),
    offerWindowMs: a.offerWindowHours ? a.offerWindowHours * 3600_000 : undefined,
    deliveryWindowMs: a.deliveryWindowHours ? a.deliveryWindowHours * 3600_000 : undefined,
  }))),
);

server.tool('list_open_tasks', 'List tasks waiting for a seller.', { category: z.string().optional() },
  (a) => run(() => engine.listOpenTasks(a.category).map(view)));

server.tool('commit', 'Seller commits to an open task and locks a small stake.', { contractId: z.string(), sellerId: z.string() },
  (a) => run(() => view(engine.commit(a.contractId, a.sellerId))));

server.tool(
  'deliver',
  'Seller delivers output with a compute report. Starts the 24h buyer assessment window.',
  {
    contractId: z.string(), sellerId: z.string(), output: z.any(), notes: z.string().optional(),
    compute: z.object({
      model: z.string(), inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0),
      durationMs: z.number().int().min(0), toolCalls: z.number().int().min(0),
      measurement: z.enum(['RUNTIME_METERED', 'SELF_REPORTED', 'ESTIMATED']),
    }),
  },
  (a) => run(() => view(engine.deliver(a.contractId, a.sellerId, a.output, a.compute, a.notes))),
);

server.tool('accept', 'Buyer accepts delivered work with a quality claim in [0,1]. Funds release now; 10% of acceptances are sampled for calibration.',
  { contractId: z.string(), buyerId: z.string(), qualityClaim: quality },
  (a) => run(() => view(engine.accept(a.contractId, a.buyerId, a.qualityClaim))));

server.tool('request_revision', 'Buyer asks for specific fixes (max 3 rounds). Seller has 48h to redeliver.',
  { contractId: z.string(), buyerId: z.string(), qualityClaim: quality, issues: z.array(z.string()).min(1).max(20) },
  (a) => run(() => view(engine.requestRevision(a.contractId, a.buyerId, a.qualityClaim, a.issues))));

server.tool('dispute', 'Buyer disputes delivered work, posts a bond, and three verifiers decide.',
  { contractId: z.string(), buyerId: z.string(), qualityClaim: quality, reason: z.string() },
  (a) => run(() => view(engine.dispute(a.contractId, a.buyerId, a.qualityClaim, a.reason))));

server.tool('attest', 'Assigned verifier scores the work. Consensus settles the contract when all verifiers have attested.',
  { contractId: z.string(), verifierId: z.string(), quality, confidence: quality },
  (a) => run(() => view(engine.attest(a.contractId, a.verifierId, a.quality, a.confidence))));

server.tool('get_contract', 'Full contract view including events and settlement.', { contractId: z.string() },
  (a) => run(() => view(engine.contract(a.contractId))));

server.tool('get_agent', 'Agent profile, reputation, calibration and balance.', { agentId: z.string() },
  (a) => run(() => agentView(engine.agent(a.agentId))));

server.tool('tick', 'Apply deadline-driven transitions (cancel, expire, escalate). Returns contracts that changed.', {},
  () => run(() => engine.tick().map(view)));

server.tool('run_verifiers', 'Have this server\'s model-backed verifiers score and attest on any rounds they are assigned to.', {},
  async () => {
    if (!autoVerifier) return { content: [{ type: 'text' as const, text: JSON.stringify({ configured: false, hint: 'set HOLDWORK_AUTO_VERIFIERS' }) }] };
    try {
      const done = await autoVerifier.run();
      save();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ configured: true, attested: done }, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: 'SCORER_ERROR', message: String(e) }) }] };
    }
  });

const transport = new StdioServerTransport();
await server.connect(transport);
