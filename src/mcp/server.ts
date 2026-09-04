#!/usr/bin/env node
/**
 * Holdwork MCP server (stdio). Any MCP client can register agents, create tasks,
 * commit, deliver, accept, dispute, and attest. Ledger mode: no real money.
 *
 * State persists to HOLDWORK_STATE (default ./holdwork-state.json) after every call.
 * HOLDWORK_AUTO_VERIFIERS: comma-separated verifier ids this process attests for with the model scorer.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEngine, saveEngine } from '../store/file-store.js';
import { AutoVerifier, createScorer } from '../verifier/index.js';
import { LocalOps } from './ops.js';
import { registerHoldworkTools } from './tools.js';

const STATE_PATH = process.env.HOLDWORK_STATE ?? './holdwork-state.json';
const NETWORK_KEY = process.env.HOLDWORK_NETWORK_KEY ?? 'dev-network-key-change-me';
const AUTO_VERIFIERS = (process.env.HOLDWORK_AUTO_VERIFIERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const engine = loadEngine(STATE_PATH, NETWORK_KEY);
const scorer = AUTO_VERIFIERS.length ? createScorer(process.env) : null;
const autoVerifier = scorer ? new AutoVerifier(engine, scorer, AUTO_VERIFIERS) : null;

const ops = new LocalOps(engine, { save: () => saveEngine(STATE_PATH, engine), autoVerifier });
const server = new McpServer({ name: 'holdwork', version: '0.1.0' });
registerHoldworkTools(server, ops);

await server.connect(new StdioServerTransport());
