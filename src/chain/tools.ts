/** MCP tools for real-money mode. Registered only when the server runs with an escrow contract configured. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ChainConfig, PreparedTx } from './bridge.js';
import type { OpResult } from '../mcp/ops.js';

const money = z.string().regex(/^\d+(\.\d{1,6})?$/, 'decimal USDC, up to 6 places');
const quality = z.number().min(0).max(1);

export interface ChainToolOps {
  prepareOpen(a: {
    buyerId: string; title: string; description: string; category: string; price: string;
    acceptanceCriteria?: string; outputSchema?: unknown; offerWindowHours?: number; deliveryWindowHours?: number;
    fullPayQuality?: number; zeroPayQuality?: number;
  }): Promise<OpResult>;
  prepareCommit(a: { contractId: string; sellerId: string }): Promise<OpResult>;
  prepareAccept(a: { contractId: string; buyerId: string; qualityClaim: number }): Promise<OpResult>;
  prepareDispute(a: { contractId: string; buyerId: string; qualityClaim: number; reason: string }): Promise<OpResult>;
  chainInfo(): Promise<OpResult>;
}

function reply(r: OpResult) {
  if (r.ok) return { content: [{ type: 'text' as const, text: JSON.stringify(r.result, null, 2) }] };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(r.error) }] };
}

export function describeTxs(txs: PreparedTx[]) {
  return txs.map((t) => ({ to: t.to, data: t.data, value: t.value, chainId: t.chainId, description: t.description }));
}

export function registerChainTools(server: McpServer, ops: ChainToolOps, cfg: ChainConfig): void {
  server.tool('chain_info', 'Real-money mode: chain id, escrow contract and USDC addresses, and how funding works.', {},
    async () => reply(await ops.chainInfo()));

  server.tool(
    'prepare_open',
    `Real money: create a task and get the transactions your wallet must sign to fund it (USDC approve, then escrow open). The task becomes visible to sellers only after the Opened event lands on chain ${cfg.chainId}. Register your agent with a wallet first.`,
    {
      buyerId: z.string(), title: z.string(), description: z.string(), category: z.string(), price: money,
      acceptanceCriteria: z.string().optional(), outputSchema: z.any().optional(),
      offerWindowHours: z.number().positive().optional(), deliveryWindowHours: z.number().positive().optional(),
      fullPayQuality: z.number().min(0.5).max(1).optional(), zeroPayQuality: z.number().min(0).max(1).optional(),
    },
    async (a) => reply(await ops.prepareOpen(a)),
  );

  server.tool('prepare_commit', 'Real money: get the transactions to commit to an open task (USDC approve for the stake, then escrow commit). State advances when the Committed event lands.',
    { contractId: z.string(), sellerId: z.string() },
    async (a) => reply(await ops.prepareCommit(a)));

  server.tool('prepare_accept', 'Real money: declare your quality claim and get the escrow accept transaction releasing the matching share to the seller. Your signature moves the money; no Holdwork key is involved.',
    { contractId: z.string(), buyerId: z.string(), qualityClaim: quality },
    async (a) => reply(await ops.prepareAccept(a)));

  server.tool('prepare_dispute', 'Real money: declare your dispute and get the transactions to post the bond (USDC approve, then escrow dispute). Three verifiers decide; the arbiter settles on-chain with their split.',
    { contractId: z.string(), buyerId: z.string(), qualityClaim: quality, reason: z.string() },
    async (a) => reply(await ops.prepareDispute(a)));
}
