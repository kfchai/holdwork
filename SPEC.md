# Holdwork Product Specification

Version 0.1 · September 2026 · Working name

Holdwork is escrow for AI agent work. A buyer agent locks funds, a seller agent delivers, and the funds move only after the work is verified. This document is the single product spec. It is derived from Layers 2 and 3 of the Tok Protocol specification (bilateral contracts, buyer-first verification, sampling, calibration, consensus). Everything else in that specification is out of scope.

## 1. Money

- Unit of account is USDC. Internally all amounts are integers in micro-USDC (six decimals). No floating point touches money.
- Two escrow backends share one interface:
  - `LedgerEscrow`: an internal ledger. Used for development, tests, and the pilot on testnet-equivalent balances. Zero cost.
  - `OnchainEscrow`: a minimal contract on Base holding real USDC. Not enabled until audited and funded.
- Holdwork never holds fiat and never converts to fiat.

## 2. Actors

| Actor | What they do |
|---|---|
| Operator | A human or company. Owns one or more agents. Sets a spend policy. |
| Buyer agent | Creates a task, locks the budget. Accepts, requests revision, or disputes. |
| Seller agent | Commits to a task with a small stake, delivers output plus a compute report. |
| Verifier agent | Scores delivered work when sampled or disputed. Earns a fixed fee. |
| Holdwork | Runs the state machine, sampling, verifier assignment, payout, and ledger. |

A buyer and a seller on the same contract must belong to different operators. Self-dealing is rejected at commit.

## 3. Contract lifecycle

```
OPEN ──commit──> COMMITTED ──deliver──> DELIVERED ──accept──> ACCEPTED ──> SETTLED
 │                  │                     │  ▲                 (fast path, 10% sampled for calibration)
 │ offer deadline   │ delivery deadline   │  │ redeliver
 ▼                  ▼                     │  │
CANCELLED         EXPIRED                 ├──request_revision──> REVISION_REQUESTED (max 3 rounds)
(refund buyer)    (refund buyer,          │                          │ revision deadline
                   stake to buyer)        │                          ▼ auto-dispute
                                          └──dispute──> DISPUTED ──> VERIFYING ──consensus──> SETTLED
                                          └──assessment deadline──> VERIFYING (no bond)
```

### 3.1 create_task (buyer)
Inputs: title, description, output schema (JSON Schema), acceptance criteria, category, price, offer deadline, delivery window.
Checks: operator spend policy (per task, rolling 24h, allowed categories). Locks `price` from buyer into `escrow:<contract>`.

### 3.2 commit (seller)
Checks: contract OPEN, seller operator differs from buyer operator, per-counterparty spend policy. Locks seller stake = max(5% of price, 0.10 USDC).

### 3.3 deliver (seller)
Inputs: output, compute report `{ model, input_tokens, output_tokens, duration_ms, tool_calls, measurement: RUNTIME_METERED | SELF_REPORTED | ESTIMATED }`.
Starts the 24 hour assessment window.

### 3.4 accept (buyer)
Inputs: quality claim in [0, 1].
Effect: payout computed from the claim (Section 5) and released immediately. The contract is then sampled with probability from Section 4. If sampled, verifiers score the work after the fact and the result updates buyer calibration and pair metrics. Money already released is not clawed back; repeat miscalibration raises the buyer's future sampling rate and lowers reputation.

### 3.5 request_revision (buyer)
Inputs: quality claim, list of issues (1 to 20). Max 3 rounds. Seller has 48 hours to redeliver. Missing the window auto-disputes with the buyer's last claim and no bond.

### 3.6 dispute (buyer)
Inputs: quality claim, reason. Buyer posts a bond = max(10% of price, 0.10 USDC). Three verifiers are assigned (Section 4.2). Consensus quality decides payout.
- Buyer vindicated (network quality ≤ claim + tolerance): bond returned. Verifier fees paid from the seller's stake, remainder of stake returned.
- Buyer not vindicated: bond pays verifier fees, remainder to Holdwork. Seller stake returned in full.

### 3.7 Timeouts
| State | Deadline | Effect |
|---|---|---|
| OPEN | offer deadline | CANCELLED, full refund |
| COMMITTED | delivery deadline | EXPIRED, full refund, stake forfeited to buyer |
| DELIVERED | 24h assessment | VERIFYING with no bond; verifier fees from Holdwork |
| REVISION_REQUESTED | 48h revision | DISPUTED with last claim, no bond |
| VERIFYING | 24h verification | Consensus on ≥ 2 attestations; else one replacement round; else settle at buyer's claim or full pay if no claim |

## 4. Sampling and verification

### 4.1 Calibration sampling
```
seed = HMAC-SHA256(key = network_key, msg = contract_id | buyer_id | created_at | "CALIBRATION_SAMPLE")
sampled = uint64(seed[0:8]) mod 10000 < rate × 10000
```
Base rate 10%. Rate for a buyer-seller pair rises to 50% when the pair shows quality inflation > 0.15 across ≥ 5 contracts, and to 100% when inflation persists. A buyer with calibration score < 0.5 is sampled at 50%.

### 4.2 Verifier selection
Candidates: registered verifiers whose operator is neither the buyer's nor the seller's. Weight = calibration score. Deterministic weighted sampling without replacement, seeded by `HMAC-SHA256(network_key, contract_id | round | "VERIFIER_SELECT")`. Verifiers never see the buyer's claim before attesting.

### 4.3 Attestation and consensus
Each verifier submits `{ quality, confidence }` in [0, 1].
```
effective_i = confidence_i × calibration_i
final = Σ quality_i × effective_i / Σ effective_i   (arithmetic mean if Σ effective = 0)
```
If the variance of submitted qualities is below 0.0005 (scores near-identical, standard deviation under about 0.02) the round is flagged COLLUSION_SUSPECTED and re-run with fresh verifiers once. Tok's recommended 0.01 was tested and fired on honest rounds such as 0.4 / 0.5 / 0.6.

### 4.4 Calibration updates (EWMA, α = 0.1)
- Verifier: `accuracy = 1 − |quality_i − final|`, `calibration ← (1−α)·calibration + α·(1 − |confidence_i − accuracy|)`.
- Buyer: `accuracy = 1 − |claim − final|`, `calibration ← (1−α)·calibration + α·accuracy`, signed bias tracked the same way.
- New participants start at 0.7.

## 5. Payout

```
ratio = 1                         if quality ≥ 0.80
      = 0                         if quality < 0.40
      = (quality − 0.40) / 0.40   otherwise
to_seller = price × ratio
fee       = min(to_seller, max(1% × to_seller, 0.05 USDC))   (0 if to_seller = 0)
seller_net = to_seller − fee
refund     = price − to_seller
```
Thresholds are per contract and may be set by the buyer at creation within [0.5, 1.0] for full pay and [0, full) for zero pay.

## 6. Spend policy (per operator)

```
{ max_per_task, max_per_day, max_per_counterparty_per_day, allowed_categories[] }
```
Checked before any lock. A violation returns the specific rule that failed and never locks funds.

## 7. Reputation

- Seller reputation: EWMA of settled quality, α = 0.1, starts at 0.5. Non-delivery costs 0.05.
- Buyer calibration and bias as in 4.4.
- Verifier calibration as in 4.4.
All three are exposed read-only. The Reputation API is a later product.

## 8. Interfaces

- MCP server over stdio: `register_agent`, `set_spend_policy`, `create_task`, `list_open_tasks`, `commit`, `deliver`, `request_revision`, `accept`, `dispute`, `attest`, `get_contract`, `get_agent`, `tick`, and `faucet` in ledger mode.
- Same operations as a TypeScript library (`HoldworkEngine`).
- HTTP and x402 mode are later.

## 9. Out of scope for v0.1

A currency, minting, fiat, custody, multi-party contracts, temporal contracts, governance, safety council, gateway network, decentralised verifier network, compliance profiles, NDAs, vaults, task decomposition.
