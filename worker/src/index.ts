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
import { HoldworkEngine, type ComputeReport } from '../../src/core/index.js';
import { deserializeEngine, serializeEngine } from '../../src/store/serialize.js';
import { AutoVerifier, ClaudeScorer } from '../../src/verifier/index.js';
import { LocalOps, type HoldworkOps, type OpResult } from '../../src/mcp/ops.js';
import { registerHoldworkTools } from '../../src/mcp/tools.js';

export interface Env {
  HOLDWORK_LEDGER: DurableObjectNamespace<HoldworkLedger>;
  HOLDWORK_MCP: DurableObjectNamespace<HoldworkMcp>;
  HOLDWORK_NETWORK_KEY?: string;
  HOLDWORK_TOKEN?: string;
  HOLDWORK_AUTO_VERIFIERS?: string;
  HOLDWORK_SCORER_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
}

const STATE_KEY = 'engine';

// ───────────────────────── the ledger ─────────────────────────

export class HoldworkLedger extends DurableObject<Env> {
  private ops: Promise<LocalOps> | null = null;

  private getOps(): Promise<LocalOps> {
    this.ops ??= (async () => {
      const networkKey = this.env.HOLDWORK_NETWORK_KEY ?? 'dev-network-key-change-me';
      const json = await this.ctx.storage.get<string>(STATE_KEY);
      const engine = json ? deserializeEngine(json, networkKey) : new HoldworkEngine({ networkKey });
      const verifierIds = (this.env.HOLDWORK_AUTO_VERIFIERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const autoVerifier = verifierIds.length && this.env.ANTHROPIC_API_KEY
        ? new AutoVerifier(engine, new ClaudeScorer({ model: this.env.HOLDWORK_SCORER_MODEL, apiKey: this.env.ANTHROPIC_API_KEY }), verifierIds)
        : null;
      return new LocalOps(engine, {
        save: () => this.ctx.storage.put(STATE_KEY, serializeEngine(engine)),
        autoVerifier,
      });
    })();
    return this.ops;
  }

  // One RPC method per op. Explicit rather than a generic dispatcher so the surface is auditable.
  async registerAgent(a: Parameters<HoldworkOps['registerAgent']>[0]) { return (await this.getOps()).registerAgent(a); }
  async faucet(a: { agentId: string; amount: string }) { return (await this.getOps()).faucet(a); }
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

  /** Deadline sweep. The alarm re-arms itself every 10 minutes. */
  async alarm() {
    await (await this.getOps()).tick();
    await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
  }

  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 60 * 1000);
  }

  async stats() {
    const ops = await this.getOps();
    const r = await ops.listOpenTasks({});
    return { openTasks: r.ok ? (r.result as unknown[]).length : null };
  }
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
  };
}

export class HoldworkMcp extends McpAgent<Env> {
  server = new McpServer({ name: 'holdwork', version: '0.1.0' });

  async init() {
    registerHoldworkTools(this.server, ledgerOps(this.env));
  }
}

// ───────────────────────── router ─────────────────────────

function authorized(request: Request, env: Env): boolean {
  if (!env.HOLDWORK_TOKEN) return true; // no token configured: open (dev only)
  const header = request.headers.get('authorization') ?? '';
  return header === `Bearer ${env.HOLDWORK_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      const ledger = env.HOLDWORK_LEDGER.get(env.HOLDWORK_LEDGER.idFromName('main'));
      ctx.waitUntil(ledger.ensureAlarm());
      const stats = await ledger.stats();
      return Response.json({ service: 'holdwork', version: '0.1.0', mcp: '/mcp', auth: env.HOLDWORK_TOKEN ? 'bearer' : 'open', ...stats });
    }

    if (url.pathname.startsWith('/mcp')) {
      if (!authorized(request, env)) return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      return HoldworkMcp.serve('/mcp', { binding: 'HOLDWORK_MCP' }).fetch(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
