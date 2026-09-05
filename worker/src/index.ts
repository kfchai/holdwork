/**
 * Holdwork on Cloudflare Workers.
 *
 *   HoldworkLedger  one Durable Object instance ("main") owns the engine and its state.
 *                   Single writer, so every mutation is serialized. State persists in DO storage.
 *   HoldworkMcp     McpAgent, one instance per client session, exposes the tool surface over
 *                   Streamable HTTP and forwards every call to the ledger over RPC.
 *
 * Auth for the pilot is one shared bearer token (HOLDWORK_TOKEN secret). Not a substitute for
 * per-operator auth; that arrives with the first design partner.
 */
import { DurableObject } from 'cloudflare:workers';
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HoldworkEngine, HoldworkError, usdc, type ComputeReport } from '../../src/core/index.js';
import { deserializeEngine, serializeEngine } from '../../src/store/serialize.js';
import { AutoVerifier, createScorer } from '../../src/verifier/index.js';
import { LocalOps, type HoldworkOps, type OpResult, type Stats } from '../../src/mcp/ops.js';
import { registerHoldworkTools } from '../../src/mcp/tools.js';
import { ChainOps, decodeEscrowLog, registerChainTools, describeTxs, type ChainConfig, type ChainToolOps } from '../../src/chain/index.js';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

export interface Env {
  HOLDWORK_LEDGER: DurableObjectNamespace<HoldworkLedger>;
  HOLDWORK_MCP: DurableObjectNamespace<HoldworkMcp>;
  HOLDWORK_NETWORK_KEY?: string;
  HOLDWORK_TOKEN?: string;
  HOLDWORK_AUTO_VERIFIERS?: string;
  /** e.g. "openrouter:z-ai/glm-5.3-flash" or "claude:claude-opus-5" */
  HOLDWORK_SCORER?: string;
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Real-money mode switches on when HOLDWORK_ESCROW_ADDRESS is set. */
  HOLDWORK_CHAIN?: 'base-sepolia' | 'base';
  HOLDWORK_ESCROW_ADDRESS?: string;
  HOLDWORK_USDC_ADDRESS?: string;
  HOLDWORK_RPC_URL?: string;
  HOLDWORK_CHAIN_START_BLOCK?: string;
  /** Arbiter hot key. Signs dispute settlements and permissionless refunds only. */
  ARBITER_PRIVATE_KEY?: string;
}

const STATE_KEY = 'engine';
const LAST_BLOCK_KEY = 'chain:lastBlock';
const VERIFY_DELAY_MS = 1_000;
const VERIFY_RETRY_MS = 60_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;
const CHAIN_POLL_MS = 60_000;

const USDC_BY_CHAIN: Record<string, Address> = {
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

function chainConfig(env: Env): ChainConfig | null {
  if (!env.HOLDWORK_ESCROW_ADDRESS) return null;
  const name = env.HOLDWORK_CHAIN ?? 'base-sepolia';
  const chain = name === 'base' ? base : baseSepolia;
  return { chainId: chain.id, escrow: env.HOLDWORK_ESCROW_ADDRESS as Address, usdc: (env.HOLDWORK_USDC_ADDRESS ?? USDC_BY_CHAIN[name]) as Address };
}
function viemChain(env: Env) { return (env.HOLDWORK_CHAIN ?? 'base-sepolia') === 'base' ? base : baseSepolia; }

// ───────────────────────── the ledger ─────────────────────────

export class HoldworkLedger extends DurableObject<Env> {
  private ops: Promise<LocalOps> | null = null;
  private engine: HoldworkEngine | null = null;
  private chain: ChainOps | null = null;

  private getOps(): Promise<LocalOps> {
    this.ops ??= (async () => {
      const networkKey = this.env.HOLDWORK_NETWORK_KEY ?? 'dev-network-key-change-me';
      const json = await this.ctx.storage.get<string>(STATE_KEY);
      const engine = json ? deserializeEngine(json, networkKey) : new HoldworkEngine({ networkKey });
      this.engine = engine;
      const cfg = chainConfig(this.env);
      this.chain = cfg ? new ChainOps(engine, cfg) : null;
      const verifierIds = (this.env.HOLDWORK_AUTO_VERIFIERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const scorer = verifierIds.length ? createScorer(this.env) : null;
      const autoVerifier = scorer ? new AutoVerifier(engine, scorer, verifierIds) : null;
      return new LocalOps(engine, {
        save: () => this.ctx.storage.put(STATE_KEY, serializeEngine(engine)),
        autoVerifier,
        // Scoring takes up to a minute per verifier; never make the caller wait for it.
        deferAutoVerify: () => this.armAlarm(VERIFY_DELAY_MS),
      });
    })();
    return this.ops;
  }

  private save() { return this.ctx.storage.put(STATE_KEY, serializeEngine(this.engine!)); }

  // ───────── real-money mode: prepare + chain info ─────────

  private async chainRun<T>(fn: (c: ChainOps) => T): Promise<OpResult<T>> {
    await this.getOps();
    if (!this.chain) return { ok: false, error: { code: 'CHAIN_MODE_OFF', message: 'This deployment runs on the internal ledger; use create_task / commit / accept / dispute' } };
    try {
      const result = fn(this.chain);
      await this.save();
      return { ok: true, result };
    } catch (e) {
      const err = e instanceof HoldworkError ? { code: e.code, message: e.message } : { code: 'ERROR', message: String(e) };
      return { ok: false, error: err };
    }
  }

  async chainInfo() {
    return this.chainRun((c) => ({
      chainId: c.cfg.chainId, escrow: c.cfg.escrow, usdc: c.cfg.usdc,
      how: 'Register with a wallet. prepare_* tools return transactions for your wallet to sign. State advances when the event lands; the indexer polls every minute. Holdwork signs only dispute settlements and deadline refunds.',
      arbiter: this.env.ARBITER_PRIVATE_KEY ? privateKeyToAccount(this.env.ARBITER_PRIVATE_KEY as Hex).address : null,
    }));
  }
  async prepareOpen(a: Parameters<ChainToolOps['prepareOpen']>[0]) {
    return this.chainRun((c) => {
      const r = c.prepareOpen({
        ...a, price: usdc(a.price),
        offerWindowMs: a.offerWindowHours ? a.offerWindowHours * 3600_000 : undefined,
        deliveryWindowMs: a.deliveryWindowHours ? a.deliveryWindowHours * 3600_000 : undefined,
      });
      return { contractId: r.contract.id, onchainId: r.onchainId, state: r.contract.state, transactions: describeTxs(r.transactions) };
    });
  }
  async prepareCommit(a: { contractId: string; sellerId: string }) {
    return this.chainRun((c) => { const r = c.prepareCommit(a.contractId, a.sellerId); return { contractId: r.contract.id, transactions: describeTxs(r.transactions) }; });
  }
  async prepareAccept(a: { contractId: string; buyerId: string; qualityClaim: number }) {
    return this.chainRun((c) => { const r = c.prepareAccept(a.contractId, a.buyerId, a.qualityClaim); return { contractId: r.contract.id, toSeller: r.toSeller.toString(), transactions: describeTxs(r.transactions) }; });
  }
  async prepareDispute(a: { contractId: string; buyerId: string; qualityClaim: number; reason: string }) {
    return this.chainRun((c) => { const r = c.prepareDispute(a.contractId, a.buyerId, a.qualityClaim, a.reason); return { contractId: r.contract.id, transactions: describeTxs(r.transactions) }; });
  }

  /** Index new escrow events and submit any arbiter actions owed to the chain. */
  private async syncChain(): Promise<void> {
    if (!this.chain) return;
    const cfg = this.chain.cfg;
    const publicClient = createPublicClient({ chain: viemChain(this.env), transport: http(this.env.HOLDWORK_RPC_URL) });
    const latest = await publicClient.getBlockNumber();
    const stored = await this.ctx.storage.get<string>(LAST_BLOCK_KEY);
    const from = stored ? BigInt(stored) + 1n : BigInt(this.env.HOLDWORK_CHAIN_START_BLOCK ?? '0') || latest - 1000n;
    if (from <= latest) {
      // Bounded range per pass so a long gap cannot exceed RPC log limits.
      const to = latest - from > 2000n ? from + 2000n : latest;
      const logs = await publicClient.getLogs({ address: cfg.escrow, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const ev = decodeEscrowLog(log);
        if (!ev) continue;
        try {
          const applied = this.chain.applyEvent(ev, log.transactionHash ?? '');
          if (applied) console.log(`[chain] ${applied}`);
        } catch (e) {
          console.error(`[chain] event ${ev.name} for ${ev.id} rejected: ${String(e)}`);
        }
      }
      await this.ctx.storage.put(LAST_BLOCK_KEY, to.toString());
    }
    if (this.env.ARBITER_PRIVATE_KEY) {
      const account = privateKeyToAccount(this.env.ARBITER_PRIVATE_KEY as Hex);
      const wallet = createWalletClient({ chain: viemChain(this.env), account, transport: http(this.env.HOLDWORK_RPC_URL) });
      for (const action of this.chain.pendingArbiterActions()) {
        try {
          const hash = await wallet.sendTransaction({ to: action.tx.to, data: action.tx.data });
          this.chain.markSubmitted(action.contractId, action.action, hash);
          console.log(`[chain] ${action.action} ${action.contractId} tx ${hash}`);
        } catch (e) {
          console.error(`[chain] ${action.action} ${action.contractId} failed: ${String(e)}`);
        }
      }
    }
    await this.save();
  }

  /** Move the alarm earlier if needed; never later. */
  private async armAlarm(delayMs: number): Promise<void> {
    const at = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // One RPC method per op. Explicit rather than a generic dispatcher so the surface is auditable.
  async registerAgent(a: Parameters<HoldworkOps['registerAgent']>[0]) { return (await this.getOps()).registerAgent(a); }
  async faucet(a: { agentId: string; amount: string }) {
    const ops = await this.getOps();
    if (this.chain) return { ok: false, error: { code: 'CHAIN_MODE', message: 'Real-money deployment: fund your wallet with USDC and use prepare_open' } } as OpResult;
    return ops.faucet(a);
  }
  async setSpendPolicy(a: Parameters<HoldworkOps['setSpendPolicy']>[0]) { return (await this.getOps()).setSpendPolicy(a); }
  async createTask(a: Parameters<HoldworkOps['createTask']>[0]) { return (await this.getOps()).createTask(a); }
  async listOpenTasks(a: { category?: string }) { return (await this.getOps()).listOpenTasks(a); }
  async commit(a: { contractId: string; sellerId: string }) { return (await this.getOps()).commit(a); }
  async deliver(a: { contractId: string; sellerId: string; output: unknown; compute: ComputeReport; notes?: string }) { return (await this.getOps()).deliver(a); }
  async accept(a: { contractId: string; buyerId: string; qualityClaim: number }) { return (await this.getOps()).accept(a); }
  async requestRevision(a: { contractId: string; buyerId: string; qualityClaim: number; issues: string[] }) { return (await this.getOps()).requestRevision(a); }
  async dispute(a: { contractId: string; buyerId: string; qualityClaim: number; reason: string }) { return (await this.getOps()).dispute(a); }
  async attest(a: { contractId: string; verifierId: string; quality: number; confidence: number }) { return (await this.getOps()).attest(a); }
  async getContract(a: { contractId: string }) { return (await this.getOps()).getContract(a); }
  async getAgent(a: { agentId: string }) { return (await this.getOps()).getAgent(a); }
  async tick() { return (await this.getOps()).tick(); }
  async runVerifiers() { return (await this.getOps()).runVerifiers(); }

  /**
   * Background work: sweep deadlines, then let model verifiers attest on anything pending.
   * Re-arms in 1 minute while verification is outstanding, otherwise every 10 minutes.
   */
  async alarm() {
    const ops = await this.getOps();
    if (this.chain) {
      try { await this.syncChain(); } catch (e) { console.error(`[chain] sync failed: ${String(e)}`); }
    }
    await ops.tick();
    if (ops.hasPendingVerification()) await ops.runVerifiers();
    if (this.chain) {
      // A settlement or timeout may have just produced an arbiter action; push it without waiting a cycle.
      try { await this.syncChain(); } catch (e) { console.error(`[chain] post-tick sync failed: ${String(e)}`); }
    }
    const next = ops.hasPendingVerification() ? VERIFY_RETRY_MS : this.chain ? CHAIN_POLL_MS : SWEEP_INTERVAL_MS;
    await this.ctx.storage.setAlarm(Date.now() + next);
  }

  async ensureAlarm() {
    await this.armAlarm(60 * 1000);
  }

  async stats() { return (await this.getOps()).stats(); }
  async myAssignments(a: { verifierId: string }) { return (await this.getOps()).myAssignments(a); }
}

// ───────────────────────── the MCP front door ─────────────────────────

/** Forwards every op to the single ledger instance. */
function ledgerOps(env: Env): HoldworkOps {
  const stub = env.HOLDWORK_LEDGER.get(env.HOLDWORK_LEDGER.idFromName('main'));
  // RPC stubs return promises wrapped with Disposable; await and hand back the plain envelope.
  const call = async (p: PromiseLike<unknown>): Promise<OpResult> => (await p) as OpResult;
  return {
    registerAgent: (a) => call(stub.registerAgent(a)),
    faucet: (a) => call(stub.faucet(a)),
    setSpendPolicy: (a) => call(stub.setSpendPolicy(a)),
    createTask: (a) => call(stub.createTask(a)),
    listOpenTasks: (a) => call(stub.listOpenTasks(a)),
    commit: (a) => call(stub.commit(a)),
    deliver: (a) => call(stub.deliver(a)),
    accept: (a) => call(stub.accept(a)),
    requestRevision: (a) => call(stub.requestRevision(a)),
    dispute: (a) => call(stub.dispute(a)),
    attest: (a) => call(stub.attest(a)),
    getContract: (a) => call(stub.getContract(a)),
    getAgent: (a) => call(stub.getAgent(a)),
    tick: () => call(stub.tick()),
    runVerifiers: () => call(stub.runVerifiers()),
    stats: () => call(stub.stats()) as Promise<OpResult<Stats>>,
    myAssignments: (a) => call(stub.myAssignments(a)),
  };
}

export class HoldworkMcp extends McpAgent<Env> {
  server = new McpServer({ name: 'holdwork', version: '0.1.0' });

  async init() {
    registerHoldworkTools(this.server, ledgerOps(this.env));
    const cfg = chainConfig(this.env);
    if (cfg) {
      const stub = this.env.HOLDWORK_LEDGER.get(this.env.HOLDWORK_LEDGER.idFromName('main'));
      const call = async (p: PromiseLike<unknown>): Promise<OpResult> => (await p) as OpResult;
      registerChainTools(this.server, {
        prepareOpen: (a) => call(stub.prepareOpen(a)),
        prepareCommit: (a) => call(stub.prepareCommit(a)),
        prepareAccept: (a) => call(stub.prepareAccept(a)),
        prepareDispute: (a) => call(stub.prepareDispute(a)),
        chainInfo: () => call(stub.chainInfo()),
      }, cfg);
    }
  }
}

// ───────────────────────── router ─────────────────────────

/**
 * Pilot auth. HOLDWORK_TOKEN holds one or more tokens, comma separated, each optionally
 * prefixed with a partner name: "acme:abc123,internal:def456". Any listed token is accepted and
 * one partner can be revoked without rotating the others. Returns the partner name, or null.
 */
function authorizedPartner(request: Request, env: Env): string | null {
  if (!env.HOLDWORK_TOKEN) return 'open'; // no token configured: open (dev only)
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) return null;
  for (const entry of env.HOLDWORK_TOKEN.split(',')) {
    const idx = entry.indexOf(':');
    const name = idx === -1 ? 'default' : entry.slice(0, idx).trim();
    const token = (idx === -1 ? entry : entry.slice(idx + 1)).trim();
    if (token && timingSafeEqualStr(token, presented)) return name;
  }
  return null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const ledger = env.HOLDWORK_LEDGER.get(env.HOLDWORK_LEDGER.idFromName('main'));

    if (url.pathname === '/' || url.pathname === '/health') {
      ctx.waitUntil(ledger.ensureAlarm());
      const r = await ledger.stats();
      const s = r.ok ? r.result : null;
      const cfg = chainConfig(env);
      return Response.json({
        service: 'holdwork', version: '0.1.0', mcp: '/mcp', auth: env.HOLDWORK_TOKEN ? 'bearer' : 'open',
        mode: cfg ? 'real-money' : 'ledger', chain: cfg ? { chainId: cfg.chainId, escrow: cfg.escrow, usdc: cfg.usdc } : null,
        openTasks: s?.contractsByState.OPEN ?? 0, settled: s?.settled ?? 0, disputes: s?.disputes ?? 0,
      });
    }

    if (url.pathname === '/stats') {
      if (!authorizedPartner(request, env)) return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      const r = await ledger.stats();
      return Response.json(r.ok ? r.result : { error: r.error });
    }

    if (url.pathname.startsWith('/mcp')) {
      const partner = authorizedPartner(request, env);
      if (!partner) return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      return HoldworkMcp.serve('/mcp', { binding: 'HOLDWORK_MCP' }).fetch(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
