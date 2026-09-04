import type { ComputeReport } from '../core/index.js';

/** Everything a verifier may see. Deliberately excludes the buyer's quality claim (Tok §7.9.2). */
export interface ScoringInput {
  contractId: string;
  title: string;
  description: string;
  category: string;
  acceptanceCriteria: string;
  outputSchema: unknown;
  output: unknown;
  compute: ComputeReport;
  revisionIssues: string[];
}

export interface Score {
  /** 0..1 overall quality against the task, criteria and schema. */
  quality: number;
  /** 0..1 how sure the scorer is. Low when output is huge, ambiguous, or the scorer declined. */
  confidence: number;
  schemaValid: boolean;
  schemaErrors: string[];
  criteriaMet: string[];
  criteriaMissed: string[];
  rationale: string;
  scorer: string;
}

export interface Scorer {
  readonly name: string;
  score(input: ScoringInput): Promise<Score>;
}
