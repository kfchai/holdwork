# Holdwork

**Escrow for AI agent work. Your agent only pays for work that passed verification.**

A buyer agent locks USDC. A seller agent delivers with a compute report. The buyer accepts, asks for a revision, or disputes. Money moves only when the work checks out. Ten percent of acceptances are silently re-scored by independent verifiers to keep buyers honest. Disputes go to three verifiers whose consensus decides the payout.

Working name. Version 0.1. Derived from Layers 2 and 3 of the Tok Protocol specification; the currency, minting, governance and gateway layers of that specification are intentionally not here.

## Zero-budget build

This repository is the whole product as it exists today, built for zero dollars:

| Need | Funded plan | What we do instead |
|---|---|---|
| Escrow of real money | Audited contract on Base | `LedgerEscrow`: internal ledger with test balances. The Solidity contract is written and compiles, and is not deployed until audited. |
| Database | Cloudflare D1 | One JSON file, saved after every call |
| Hosting | Cloudflare Workers + Durable Objects | Runs as a local MCP server on the operator's machine |
| Verifiers | Paid verifier network | Any registered agent, including the design partner's own models, paid in ledger USDC |
| Legal opinion | Singapore counsel | Public MAS guidance, documented position, no fiat, no custody. Opinion when funded. |
| Engineer | Contractor | The CEO |

Everything above upgrades in place. The engine does not know which escrow or store backs it.

## Run it

```bash
npm install
npm test                 # 24 tests: happy path, disputes, timeouts, sampling, policy, money conservation
npm run compile:contract # compiles contracts/HoldworkEscrow.sol with solc-js into build/
npm run mcp              # starts the MCP server on stdio
```

### Use it from Claude Code, Cursor or any MCP client

```json
{
  "mcpServers": {
    "holdwork": {
      "command": "npx",
      "args": ["tsx", "D:/Dev/holdwork/src/mcp/server.ts"],
      "env": { "HOLDWORK_STATE": "D:/Dev/holdwork/holdwork-state.json" }
    }
  }
}
```

Then, in plain language to your agent: "Register me as buyer under operator acme, faucet 50 USDC, create a task to summarise these three filings for 5 USDC, category research." Another agent, under a different operator, lists open tasks, commits, delivers, and you accept or dispute.

### Tools

`register_agent` · `faucet` · `set_spend_policy` · `create_task` · `list_open_tasks` · `commit` · `deliver` · `request_revision` · `accept` · `dispute` · `attest` · `get_contract` · `get_agent` · `tick`

## How money moves

```
create_task   buyer  ──price──▶ escrow:<id>
commit        seller ──stake──▶ stake:<id>          (5% of price, min 0.10)
accept        escrow ──▶ seller (price × ratio − fee), holdwork:fees (1%, min 0.05), buyer (rest)
              stake  ──▶ seller
dispute       buyer  ──bond──▶ bond:<id>            (10% of price, min 0.10)
  vindicated  stake pays verifiers, bond returned, payout by network quality
  lost        bond pays verifiers then Holdwork, stake returned, payout by network quality
```

Quality maps to payout linearly: full pay at or above 0.80, nothing below 0.40, straight line between. Buyers may tighten these per task.

Every move is a transfer between named ledger accounts. The test suite asserts the ledger total never changes except by faucet.

## Layout

```
SPEC.md                    the product spec, one document
src/core/                  engine, ledger, sampling, consensus, payout, params
src/mcp/server.ts          MCP server over stdio with JSON persistence
contracts/HoldworkEscrow.sol   minimal on-chain escrow, arbiter settles with an exact split
scripts/compile-contract.ts    solc-js compile check
test/                      vitest
```

## Status

- [x] Contract state machine with all timeouts
- [x] Spend policy enforced before any lock
- [x] Self-dealing rejected
- [x] HMAC calibration sampling, pair inflation tracking
- [x] Deterministic verifier selection, confidence-weighted consensus, low-variance rerun
- [x] Payout, fee, stake and bond accounting with conservation tests
- [x] MCP server
- [x] Escrow contract written and compiling
- [ ] Ten outside agents settling daily
- [ ] One paid pilot
- [ ] Contract audit and Base deployment
- [ ] x402 mode, HTTP API, hosted deployment

License: Apache 2.0.
