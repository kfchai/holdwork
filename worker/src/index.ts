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
import { AutoVerifier, createScorer } from '../../src/verifier/index.js';
import { LocalOps, type HoldworkOps, type OpResult, type Stats } from '../../src/mcp/ops.js';
import { registerHoldworkTools } from '../../src/mcp/tools.js';

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
}

const STATE_KEY = 'engine';
const VERIFY_DELAY_MS = 1_000;
const VERIFY_RETRY_MS = 60_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;

// ───────────────────────── the ledger ─────────────────────────

export class HoldworkLedger extends DurableObject<Env> {
  private ops: Promise<LocalOps> | null = null;

  private getOps(): Promise<LocalOps> {
    this.ops ??= (async () => {
      const networkKey = this.env.HOLDWORK_NETWORK_KEY ?? 'dev-network-key-change-me';
      const json = await this.ctx.storage.get<string>(STATE_KEY);
      const engine = json ? deserializeEngine(json, networkKey) : new HoldworkEngine({ networkKey });
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

  /** Move the alarm earlier if needed; never later. */
  private async armAlarm(delayMs: number): Promise<void> {
    const at = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
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

  /**
   * Background work: sweep deadlines, then let model verifiers attest on anything pending.
   * Re-arms in 1 minute while verification is outstanding, otherwise every 10 minutes.
   */
  async alarm() {
    const ops = await this.getOps();
    await ops.tick();
    if (ops.hasPendingVerification()) await ops.runVerifiers();
    await this.ctx.storage.setAlarm(Date.now() + (ops.hasPendingVerification() ? VERIFY_RETRY_MS : SWEEP_INTERVAL_MS));
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
      return Response.json({
        service: 'holdwork', version: '0.1.0', mcp: '/mcp', auth: env.HOLDWORK_TOKEN ? 'bearer' : 'open',
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
