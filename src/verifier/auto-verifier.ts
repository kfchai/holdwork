/**
 * AutoVerifier: for each verifier agent it controls, find open verification rounds where that
 * agent is assigned and has not attested, score the delivered work, and attest.
 *
 * Runs inside the same process as the engine so there is a single writer to the state.
 * By default every verifier gets its own scoring call, so a panel drawn from one model still
 * produces independent judgements rather than three copies of one.
 */
import { HoldworkEngine, type Contract } from '../core/index.js';
import type { Scorer, ScoringInput } from './types.js';

export interface AutoAttestation {
  contractId: string;
  verifierId: string;
  round: number;
  quality: number;
  confidence: number;
  rationale: string;
  scorer: string;
}

export interface AutoVerifierOptions {
  /** Share one scoring call across all of our verifiers on a contract. Cheaper, but identical scores trip the collusion guard. */
  shareScore?: boolean;
}

export class AutoVerifier {
  constructor(
    private readonly engine: HoldworkEngine,
    private readonly scorer: Scorer,
    private readonly verifierIds: string[],
    private readonly opts: AutoVerifierOptions = {},
  ) {}

  /** Find every (contract, verifier) pair with an outstanding assignment. */
  pending(): Array<{ contract: Contract; verifierId: string; round: number }> {
    const out: Array<{ contract: Contract; verifierId: string; round: number }> = [];
    for (const c of this.engine.contracts.values()) {
      const round = c.verification[c.verification.length - 1];
      if (!round || round.result) continue;
      for (const v of this.verifierIds) {
        if (round.verifierIds.includes(v) && !round.attestations.some((a) => a.verifierId === v)) {
          out.push({ contract: c, verifierId: v, round: round.round });
        }
      }
    }
    return out;
  }

  /** Score and attest every pending assignment. */
  async run(): Promise<AutoAttestation[]> {
    const done: AutoAttestation[] = [];
    const byContract = new Map<string, Array<{ verifierId: string; round: number }>>();
    for (const p of this.pending()) {
      const list = byContract.get(p.contract.id) ?? [];
      list.push({ verifierId: p.verifierId, round: p.round });
      byContract.set(p.contract.id, list);
    }
    for (const [contractId, assignments] of byContract) {
      const c = this.engine.contract(contractId);
      const input = toScoringInput(c);
      const shared = this.opts.shareScore ? await this.scorer.score(input) : null;
      for (const a of assignments) {
        // The round may have closed after an earlier attestation in this loop; re-check.
        const round = c.verification[c.verification.length - 1];
        if (!round || round.result || round.round !== a.round) continue;
        const score = shared ?? (await this.scorer.score(input));
        this.engine.attest(c.id, a.verifierId, score.quality, score.confidence);
        c.events.push({
          at: this.engine.now(), type: 'AUTO_ATTESTED', by: a.verifierId,
          data: { scorer: score.scorer, schemaValid: score.schemaValid, criteriaMissed: score.criteriaMissed, rationale: score.rationale },
        });
        done.push({ contractId: c.id, verifierId: a.verifierId, round: a.round, quality: score.quality, confidence: score.confidence, rationale: score.rationale, scorer: score.scorer });
      }
    }
    return done;
  }
}

export function toScoringInput(c: Contract): ScoringInput {
  const latest = c.deliveries[c.deliveries.length - 1];
  if (!latest) throw new Error(`Contract ${c.id} has no delivery to score`);
  return {
    contractId: c.id,
    title: c.title,
    description: c.description,
    category: c.category,
    acceptanceCriteria: c.acceptanceCriteria,
    outputSchema: c.outputSchema,
    output: latest.output,
    compute: latest.compute,
    revisionIssues: c.revisions.flatMap((r) => r.issues),
  };
}
