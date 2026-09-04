/**
 * Score three hand-made deliveries with the configured scorer and print the judgements.
 * Reads HOLDWORK_SCORER and the provider key from the environment or a secrets file passed as argv[2].
 */
import { readFileSync } from 'node:fs';
import { createScorer, type ScoringInput } from '../src/verifier/index.js';

if (process.argv[2]) {
  for (const line of readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const scorer = createScorer(process.env);
if (!scorer) throw new Error('no scorer configured');
console.log('scorer:', scorer.name);

const base = {
  contractId: 'try', category: 'research', revisionIssues: [] as string[],
  compute: { model: 'x', inputTokens: 1000, outputTokens: 500, durationMs: 3000, toolCalls: 1, measurement: 'SELF_REPORTED' as const },
  title: 'Summarise three quarterly filings',
  description: 'For each of ACME, BOLT and CRANE Q2 filings, give a one-paragraph summary of revenue trend and one stated risk, with a page citation for each fact.',
  acceptanceCriteria: 'All three companies covered. Each summary has a revenue statement, one risk, and page citations.',
  outputSchema: {
    type: 'object', required: ['summaries'],
    properties: { summaries: { type: 'array', minItems: 3, items: { type: 'object', required: ['company', 'revenue', 'risk', 'citations'], properties: { company: { type: 'string' }, revenue: { type: 'string' }, risk: { type: 'string' }, citations: { type: 'array', minItems: 1, items: { type: 'string' } } } } } },
  },
};

const cases: Array<[string, ScoringInput]> = [
  ['good', { ...base, output: { summaries: [
    { company: 'ACME', revenue: 'Revenue rose 12% year on year to 4.1bn, driven by services.', risk: 'Customer concentration: top client is 31% of revenue.', citations: ['p.14', 'p.22'] },
    { company: 'BOLT', revenue: 'Revenue flat at 890m; hardware decline offset by subscriptions.', risk: 'Supply chain exposure to a single fab.', citations: ['p.7', 'p.19'] },
    { company: 'CRANE', revenue: 'Revenue fell 6% to 2.3bn on weaker EMEA demand.', risk: 'Covenant headroom narrowed to 1.2x EBITDA.', citations: ['p.9', 'p.31'] },
  ] } }],
  ['two-of-three', { ...base, output: { summaries: [
    { company: 'ACME', revenue: 'Revenue rose 12% to 4.1bn.', risk: 'Customer concentration.', citations: ['p.14'] },
    { company: 'BOLT', revenue: 'Revenue flat at 890m.', risk: 'Single-fab supply chain.', citations: ['p.7'] },
  ] } }],
  ['placeholder', { ...base, output: { summaries: [
    { company: 'ACME', revenue: 'TODO', risk: 'TBD', citations: ['n/a'] },
    { company: 'BOLT', revenue: 'Lorem ipsum revenue text.', risk: 'Lorem ipsum.', citations: ['p.?'] },
    { company: 'CRANE', revenue: 'See filing.', risk: 'See filing.', citations: ['see filing'] },
  ] } }],
];

for (const [label, input] of cases) {
  const t0 = Date.now();
  const s = await scorer.score(input);
  console.log(`\n[${label}] quality=${s.quality.toFixed(2)} confidence=${s.confidence.toFixed(2)} schemaValid=${s.schemaValid} (${Date.now() - t0}ms)`);
  if (s.criteriaMissed.length) console.log('  missed:', s.criteriaMissed.join(' | '));
  console.log('  rationale:', s.rationale);
}
