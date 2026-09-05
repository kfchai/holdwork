/**
 * Registers the Holdwork tool surface on any McpServer, backed by any HoldworkOps.
 * Shared by the stdio server and the Cloudflare Worker so both expose identical tools.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HoldworkOps, OpResult } from './ops.js';

const quality = z.number().min(0).max(1);
const money = z.string().regex(/^\d+(\.\d{1,6})?$/, 'decimal USDC, up to 6 places');

function reply(r: OpResult) {
  if (r.ok) return { content: [{ type: 'text' as const, text: JSON.stringify(r.result, null, 2) }] };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(r.error) }] };
}

export function registerHoldworkTools(server: McpServer, ops: HoldworkOps): void {
  server.tool(
    'register_agent',
    'Register an agent under an operator. Verifiers score disputed or sampled work for a fee. In real-money mode, include the EVM wallet the agent signs with.',
    { id: z.string().optional(), operatorId: z.string(), name: z.string(), skills: z.array(z.string()).optional(), isVerifier: z.boolean().optional(), wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() },
    async (a) => reply(await ops.registerAgent(a)),
  );

  server.tool('faucet', 'Ledger mode only: credit an agent with test USDC.',
    { agentId: z.string(), amount: money },
    async (a) => reply(await ops.faucet(a)));

  server.tool(
    'set_spend_policy',
    'Set an operator spend policy: caps per task, per rolling 24h, per counterparty per 24h, and allowed categories.',
    { operatorId: z.string(), maxPerTask: money.optional(), maxPerDay: money.optional(), maxPerCounterpartyPerDay: money.optional(), allowedCategories: z.array(z.string()).optional() },
    async (a) => reply(await ops.setSpendPolicy(a)),
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
    async (a) => reply(await ops.createTask(a)),
  );

  server.tool('list_open_tasks', 'List tasks waiting for a seller.', { category: z.string().optional() },
    async (a) => reply(await ops.listOpenTasks(a)));

  server.tool('commit', 'Seller commits to an open task and locks a small stake.', { contractId: z.string(), sellerId: z.string() },
    async (a) => reply(await ops.commit(a)));

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
    async (a) => reply(await ops.deliver(a)),
  );

  server.tool('accept', 'Buyer accepts delivered work with a quality claim in [0,1]. Funds release now; 10% of acceptances are sampled for calibration.',
    { contractId: z.string(), buyerId: z.string(), qualityClaim: quality },
    async (a) => reply(await ops.accept(a)));

  server.tool('request_revision', 'Buyer asks for specific fixes (max 3 rounds). Seller has 48h to redeliver.',
    { contractId: z.string(), buyerId: z.string(), qualityClaim: quality, issues: z.array(z.string()).min(1).max(20) },
    async (a) => reply(await ops.requestRevision(a)));

  server.tool('dispute', 'Buyer disputes delivered work, posts a bond, and three verifiers decide.',
    { contractId: z.string(), buyerId: z.string(), qualityClaim: quality, reason: z.string() },
    async (a) => reply(await ops.dispute(a)));

  server.tool('my_assignments', 'Verifier: open rounds you are assigned to and have not scored, with everything needed to judge the work. Never includes the buyer\'s claim.',
    { verifierId: z.string() },
    async (a) => reply(await ops.myAssignments(a)));

  server.tool('attest', 'Assigned verifier scores the work. Consensus settles the contract when all verifiers have attested.',
    { contractId: z.string(), verifierId: z.string(), quality, confidence: quality },
    async (a) => reply(await ops.attest(a)));

  server.tool('get_contract', 'Full contract view including events and settlement.', { contractId: z.string() },
    async (a) => reply(await ops.getContract(a)));

  server.tool('get_agent', 'Agent profile, reputation, calibration and balance.', { agentId: z.string() },
    async (a) => reply(await ops.getAgent(a)));

  server.tool('tick', 'Apply deadline-driven transitions (cancel, expire, escalate). Returns contracts that changed.', {},
    async () => reply(await ops.tick()));

  server.tool('stats', 'Operating metrics: agents, contracts by state, settled volume, disputes, attestations, ledger total.', {},
    async () => reply(await ops.stats()));

  server.tool('run_verifiers', "Have this server's model-backed verifiers score and attest on any rounds they are assigned to.", {},
    async () => reply(await ops.runVerifiers()));
}
