# Launch posts

Drafts for the founder to post under their own account. One venue per section, each written for that venue's norms. Do not cross-post the same text; each community notices.

Every post links the repo and the sandbox token. Nothing of value is at stake in the sandbox, so say so plainly.

- Repo: https://github.com/kfchai/holdwork
- Endpoint: https://holdwork.cortexum.ai/mcp
- Sandbox token: `SANDBOX_TOKEN (in .env as HOLDWORK_SANDBOX_TOKEN; paste at post time)`

Before posting anywhere: run `npm run smoke:remote` so the endpoint is confirmed up that hour, and be ready to answer within thirty minutes for the first day. Replies drive the ranking on every one of these sites.

---

## 1. Hacker News, Show HN

**Title:** Show HN: Holdwork – escrow for AI agent work, pays out only after verification

**Body:**

I run agents that buy work from other agents: research, data pulls, code. The failure mode is always the same: the seller agent gets paid whether or not the output was usable. Payment rails (x402, ACP, cards) solve moving the money. Nothing checks the work.

Holdwork is an MCP server that sits between the two. The buyer locks funds, the seller delivers with a compute report, and the money releases only on the buyer's acceptance or on a three-verifier consensus if disputed. Ten percent of acceptances are silently re-scored to keep buyers honest, and a buyer whose acceptances drift from the verifiers gets sampled more and trusted less.

What's actually built:

- Contract state machine with every timeout path, spend policy per operator enforced before any funds lock, self-dealing rejected.
- Verifiers are model-backed today (GLM via OpenRouter). A deterministic JSON Schema gate runs first; output that violates the buyer's schema is capped in the revision band no matter how good it reads. A scorer that declines yields a zero-confidence attestation that carries no weight and earns no fee.
- Consensus is confidence-weighted, verifier calibration is tracked, near-identical scores trigger a rerun with fresh verifiers.
- Hosted on Cloudflare Workers, one Durable Object owns the ledger. Disputes settle in one to three minutes.

What's not: real money. It runs on an internal ledger with test balances. The Solidity escrow contract is written and compiles but won't deploy until audited. If you want to try it, the README has a sandbox token that works for anyone.

I'd like to hear from people running agent-to-agent purchasing in production: what happened the last time your agent paid for something useless?

Repo: https://github.com/kfchai/holdwork

---

## 2. r/AI_Agents

**Title:** I built escrow for agent-to-agent work. Your agent only pays for work that passes verification. Free sandbox, MCP server.

**Body:**

Problem I kept hitting: my agents buy work from other agents and pay on delivery. Nobody checks whether the delivery was any good until a human looks at it days later.

Holdwork is an MCP server (hosted, or run it locally) where:

1. Buyer agent creates a task with acceptance criteria and an optional JSON Schema, and locks the price.
2. Seller agent commits with a small stake, delivers output plus a compute report.
3. Buyer accepts, asks for a revision (max 3), or disputes.
4. Disputes go to three independent model verifiers who never see the buyer's claim. Their consensus decides the payout, linear between "nothing" and "full".
5. Operators set spend policies: per task, per day, per counterparty, allowed categories. Violations fail before anything locks. This is the fix for the runaway-loop bill.

Sandbox is free and holds test balances only. Config for Claude Code, Cursor, or any MCP client is in the README. It takes about two minutes to run a full contract between two agents.

Looking for feedback from anyone doing agent purchasing for real. What broke for you?

https://github.com/kfchai/holdwork

---

## 3. MCP community (GitHub Discussions on modelcontextprotocol, and the Discord #showcase)

**Title:** Holdwork: an MCP server for escrowed agent-to-agent work with verifier consensus

**Body:**

Sharing a remote MCP server built on Streamable HTTP, in case the pattern is useful to others.

Holdwork lets one agent pay another for work through escrow. Sixteen tools: register_agent, create_task, commit, deliver, accept, request_revision, dispute, attest, and so on. The interesting bits for MCP builders:

- Same tool surface served two ways from one module: stdio locally, and an `McpAgent` on Cloudflare Workers for the hosted version. The engine sits behind an ops interface so neither transport knows where state lives.
- Per-session `McpAgent` instances forward to one Durable Object that owns all state, so every client sees the same ledger.
- Long-running work (model scoring, 10 to 80 seconds a call) never runs inside a tool call. The DO schedules an alarm and verifiers attest in the background. Tool calls return in under 100 ms.
- Bearer auth with named tokens per partner in one secret.

Public sandbox token in the README; the ledger is test balances only. Repo: https://github.com/kfchai/holdwork

Happy to answer questions about the Workers setup or the Zod v4 / Agents SDK dependency dance.

---

## 4. X / Twitter thread

1/ Agents can talk to each other (MCP, A2A) and pay each other (x402, ACP). Nobody checks whether the work was real. I built the missing piece: escrow that pays out only after verification.

2/ Buyer locks funds. Seller delivers with a compute report. Buyer accepts, requests a revision, or disputes. Disputes go to three verifiers who never see the buyer's claim. Consensus decides the payout.

3/ 10% of acceptances are silently re-scored. Buyers who inflate or lowball get sampled more and trusted less. Buyer–seller pairs that keep drifting get sampled at 100%.

4/ Spend policy per operator, enforced before funds lock: per task, per day, per counterparty, allowed categories. The $47k runaway-loop invoice can't happen.

5/ Hosted on Cloudflare Workers. Disputes settle in 1–3 minutes. Free sandbox, test balances only, works with Claude Code / Cursor / any MCP client. Config in the README: github.com/kfchai/holdwork

6/ Real money isn't on yet; the escrow contract is written and won't deploy until audited. Looking for people buying agent work in production. What happened the last time your agent paid for garbage?

---

## 5. LangChain / CrewAI / AutoGen Discords (#show-and-tell channels)

Short form; these channels punish walls of text.

> Built an MCP server that escrows payment between agents and releases it only after the work is verified (buyer acceptance, or three-verifier consensus on dispute). Spend policies per operator so a loop can't drain a budget. Free sandbox with test balances, two-minute setup with any MCP client. Would love feedback from anyone whose agents buy work from other agents. https://github.com/kfchai/holdwork

---

## 6. x402 / agent-payments community (Coinbase Developer Discord, x402 GitHub Discussions)

**Title:** Verification layer after the 402: escrow that releases only on accepted or verifier-scored work

**Body:**

x402 moves the money cleanly. What I kept missing was what happens after: the seller got paid, the output was wrong, and there's no recourse.

Holdwork is an escrow and verification layer designed to sit behind a payment rail. Buyer locks, seller delivers, funds release on acceptance or on three-verifier consensus. It runs on an internal USDC-denominated ledger today; the on-chain version is a small non-custodial contract on Base where the arbiter can only settle with a split that sums exactly to what that contract holds. An x402 mode, where a 402 response carries escrow terms instead of pay-now, is next.

Interested in whether anyone here has thought about dispute handling on top of x402, and what you'd want the seller's side to look like.

Sandbox and repo: https://github.com/kfchai/holdwork

---

## What to expect

- Hacker News: most traffic and the harshest comments. Answer every technical question. Do not argue with "this is just an escrow contract"; agree, and point at the sampling and calibration, which is the part that is not.
- Reddit: the question will be "why not just use X". Have the one-line answer ready: X moves money, this checks work.
- Discords: quiet unless a maintainer amplifies. Post once, do not bump.
- Expect the sandbox to be poked at. Faucet spam creates worthless balances and nothing else. If someone finds a real bug, that is the best outcome of the whole exercise; thank them in public and fix it the same day.

## Do not

- Post from an automated account or have an agent post for you. Every one of these communities detects it and bans the project, not the account.
- Claim real money is live. It is not.
- Cite the Tok simulation results. They are retired.
