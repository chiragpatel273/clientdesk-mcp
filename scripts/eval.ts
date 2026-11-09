/**
 * `npm run eval`: measures extraction, client matching and search against the labelled set in eval/dataset.ts
 * and writes eval/report.json (read by the dashboard) and eval/report.md.
 *
 *   npm run eval                     # extractor from config: Claude if ANTHROPIC_API_KEY is set, else rules
 *   npm run eval -- --extractor=rules
 *   npm run eval -- --extractor=claude
 *   npm run eval -- --check          # exit 1 if any document was filed to the wrong client (CI)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeExtractor } from '../src/ai/claude-extractor.js';
import { createEmbedder } from '../src/ai/embeddings.js';
import { FIELDS, sameValue, type Extraction, type Extractor } from '../src/ai/extraction.js';
import { rulesExtractor } from '../src/ai/rules-extractor.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate, projectRoot } from '../src/db/migrate.js';
import { CLIENTS, CONTACTS } from '../src/demo/firm.js';
import { seedDemoFirm } from '../src/demo/seed.js';
import { renderTextPdf } from '../src/documents/pdf-render.js';
import { describeDocument, ingestDocument } from '../src/domain/documents.js';
import { matchClients } from '../src/domain/matching.js';
import { searchDocuments } from '../src/domain/search.js';
import { memoryFileStore } from '../src/storage/files.js';
import { DOCUMENTS, QUESTIONS, type EvalDocument } from '../eval/dataset.js';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? 'true'] as const;
  }),
);
const config = loadConfig();
const extractorName = (args.get('extractor') ?? config.extractor) as 'rules' | 'claude';
if (extractorName === 'claude' && !config.anthropicApiKey)
  throw new Error('--extractor=claude needs ANTHROPIC_API_KEY');
const extractor: Extractor =
  extractorName === 'claude' ? claudeExtractor({ apiKey: config.anthropicApiKey }) : rulesExtractor();
const embedder = createEmbedder(config);
const root = projectRoot();

const profiles = CLIENTS.filter((c) => c.id).map((c) => ({
  id: c.id,
  name: c.name,
  taxIdLast4: c.taxIdLast4,
  contacts: CONTACTS.filter((x) => x.clientId === c.id).map((x) => ({ name: x.name, email: x.email })),
}));

// ---------- extraction + matching ----------

interface CaseResult {
  doc: EvalDocument;
  extraction: Extraction;
  decision: 'file' | 'review';
  filedTo: string | null;
  fieldsCorrect: number;
  fieldsTotal: number;
  fieldErrors: string[];
  error?: string;
}

async function runCase(doc: EvalDocument): Promise<CaseResult> {
  const fieldsTotal = FIELDS[doc.docType].length;
  let extraction: Extraction;
  try {
    extraction = await extractor.extract({ filename: `${doc.id}.pdf`, pages: doc.pages, textLayer: true, pdf: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      doc,
      extraction: {
        docType: 'other',
        docTypeConfidence: 0,
        clientName: null,
        taxYear: null,
        fields: [],
        model: 'error',
      },
      decision: 'review',
      filedTo: null,
      fieldsCorrect: 0,
      fieldsTotal,
      fieldErrors: [`extraction failed: ${message}`],
      error: message,
    };
  }
  const match = matchClients(extraction, doc.pages.join('\n'), profiles, config.filing);
  const fieldErrors: string[] = [];
  let fieldsCorrect = 0;
  if (extraction.docType !== doc.docType) {
    fieldErrors.push(`type: expected ${doc.docType}, got ${extraction.docType}`);
  } else {
    for (const def of FIELDS[doc.docType]) {
      const expected = doc.fields[def.name] ?? null;
      const got = extraction.fields.find((f) => f.name === def.name)?.value ?? null;
      if (sameValue(def.kind, expected, got)) fieldsCorrect++;
      else fieldErrors.push(`${def.name}: expected ${expected ?? '∅'}, got ${got ?? '∅'}`);
    }
  }
  return {
    doc,
    extraction,
    decision: match.decision,
    filedTo: match.decision === 'file' ? (match.candidates[0]?.clientId ?? null) : null,
    fieldsCorrect,
    fieldsTotal,
    fieldErrors,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
        if (extractorName === 'claude') process.stderr.write('.');
      }
    }),
  );
  return results;
}

console.error(`Extracting ${DOCUMENTS.length} documents with ${extractorName}...`);
const cases = await mapLimit(DOCUMENTS, extractorName === 'claude' ? 4 : 8, runCase);
if (extractorName === 'claude') process.stderr.write('\n');

// ---------- search ----------

console.error(`Indexing for search with ${embedder.model}...`);
const db = await createDb('pglite://memory');
await migrate(db);
await seedDemoFirm(db);
const files = memoryFileStore();
for (const doc of DOCUMENTS) {
  if (!doc.clientId) continue;
  await ingestDocument(
    db,
    { files, embedder },
    {
      id: doc.id,
      bytes: await renderTextPdf(doc.id, doc.pages),
      mimeType: 'application/pdf',
      filename: `${doc.id}.pdf`,
      // As file_document would: a title from this run's extraction, falling back to a neutral one.
      title: describeDocument(cases.find((c) => c.doc.id === doc.id)!.extraction) ?? `Document ${doc.id}`,
      uploadedBy: null,
      filed: { clientId: doc.clientId, taxYear: doc.taxYear, docType: doc.docType, staffId: null },
    },
  );
}
const searches = [];
for (const q of QUESTIONS) {
  const passages = await searchDocuments(db, embedder, q.question, { allowedClientIds: 'all', limit: 5 });
  const rank = passages.findIndex((p) => p.documentId === q.documentId);
  const top = passages[0];
  searches.push({
    question: q,
    hit: rank >= 0,
    rank: rank >= 0 ? rank + 1 : null,
    citedCorrectly: top?.documentId === q.documentId && top.page === q.page,
    top: top ? `${top.documentId} p.${top.page}` : 'none',
  });
}
await db.close();

// ---------- metrics ----------

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);
const fieldAccuracy = ratio(sum(cases.map((c) => c.fieldsCorrect)), sum(cases.map((c) => c.fieldsTotal)));
const wrongClient = cases.filter((c) => c.filedTo !== null && c.filedTo !== c.doc.clientId).length;
const reviewRate = ratio(cases.filter((c) => c.decision === 'review').length, cases.length);
const hitRate = ratio(searches.filter((s) => s.hit).length, searches.length);
const citation = ratio(searches.filter((s) => s.citedCorrectly).length, searches.length);

const metrics = [
  { key: 'field_accuracy', label: 'Field accuracy', value: fieldAccuracy, target: 0.95, op: '>=', unit: 'percent' },
  {
    key: 'wrong_client_filings',
    label: 'Wrong-client filings',
    value: wrongClient,
    target: 0,
    op: '<=',
    unit: 'count',
  },
  { key: 'review_rate', label: 'Review-queue rate', value: reviewRate, target: 0.1, op: '<=', unit: 'percent' },
  { key: 'search_hit_rate', label: 'Search hit rate (top 5)', value: hitRate, target: 0.9, op: '>=', unit: 'percent' },
  { key: 'citation_accuracy', label: 'Citation accuracy', value: citation, target: 0.95, op: '>=', unit: 'percent' },
].map((m) => ({ ...m, pass: m.op === '>=' ? m.value >= m.target : m.value <= m.target }));

const byDocType = (['invoice', 'bank_statement', 'engagement_letter', 'tax_form'] as const).map((docType) => {
  const group = cases.filter((c) => c.doc.docType === docType);
  return {
    docType,
    documents: group.length,
    fieldAccuracy: ratio(sum(group.map((c) => c.fieldsCorrect)), sum(group.map((c) => c.fieldsTotal))),
    reviewRate: ratio(group.filter((c) => c.decision === 'review').length, group.length),
  };
});

const describeOutcome = (c: CaseResult) => (c.decision === 'file' ? `filed to ${c.filedTo}` : 'sent to review');
const reportCases = cases.map((c) => {
  const expected = c.doc.expectedAction === 'file' ? `file to ${c.doc.clientId}` : 'review';
  const actionRight = c.doc.expectedAction === 'file' ? c.filedTo === c.doc.clientId : c.decision === 'review';
  return {
    id: c.doc.id,
    docType: c.doc.docType,
    hardCase: c.doc.hardCase,
    expected,
    outcome: describeOutcome(c),
    correct: actionRight && c.fieldErrors.length === 0,
    fieldErrors: c.fieldErrors,
    model: c.extraction.model,
  };
});

const changes: string[] = await readFile(join(root, 'eval', 'changes.json'), 'utf8')
  .then((text) => JSON.parse(text) as string[])
  .catch(() => []);

const report = {
  generatedAt: new Date().toISOString(),
  extractor:
    extractorName === 'claude'
      ? 'claude (claude-haiku-5-5, escalating to claude-opus-5-5)'
      : 'rules-v1 (offline baseline)',
  embedder: embedder.model,
  thresholds: config.filing,
  dataset: { documents: DOCUMENTS.length, questions: QUESTIONS.length },
  metrics,
  byDocType,
  decisions: {
    filedCorrectly: cases.filter((c) => c.filedTo !== null && c.filedTo === c.doc.clientId).length,
    filedWrongly: wrongClient,
    reviewedAsExpected: cases.filter((c) => c.decision === 'review' && c.doc.expectedAction === 'review').length,
    reviewedUnnecessarily: cases.filter((c) => c.decision === 'review' && c.doc.expectedAction === 'file').length,
  },
  cases: reportCases,
  questions: searches.map((s) => ({
    id: s.question.id,
    question: s.question.question,
    expected: `${s.question.documentId} p.${s.question.page}`,
    paraphrased: s.question.paraphrased,
    hit: s.hit,
    rank: s.rank,
    citedCorrectly: s.citedCorrectly,
    top: s.top,
  })),
  changes,
};

// ---------- write ----------

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const show = (m: (typeof metrics)[number]) => (m.unit === 'percent' ? pct(m.value) : String(m.value));
const target = (m: (typeof metrics)[number]) =>
  `${m.op === '>=' ? '≥' : '≤'} ${m.unit === 'percent' ? pct(m.target) : m.target}`;
const md = [
  '# ClientDesk accuracy report',
  '',
  `Generated ${report.generatedAt} · extractor **${report.extractor}** · embeddings **${report.embedder}** · ` +
    `filing threshold ${config.filing.threshold}, margin ${config.filing.margin}`,
  '',
  `${DOCUMENTS.length} labelled documents (15 per type) and ${QUESTIONS.length} questions with known source pages. ` +
    'All data is synthetic. Regenerate with `npm run eval`.',
  '',
  '| Metric | Result | Target | |',
  '| --- | --- | --- | --- |',
  ...metrics.map((m) => `| ${m.label} | ${show(m)} | ${target(m)} | ${m.pass ? 'pass' : '**miss**'} |`),
  '',
  `Decisions: ${report.decisions.filedCorrectly} filed correctly, ${report.decisions.filedWrongly} filed to the wrong client, ` +
    `${report.decisions.reviewedAsExpected} sent to review as policy requires, ${report.decisions.reviewedUnnecessarily} sent to review that a person would have filed.`,
  '',
  '## By document type',
  '',
  '| Type | Documents | Field accuracy | Review rate |',
  '| --- | --- | --- | --- |',
  ...byDocType.map((t) => `| ${t.docType} | ${t.documents} | ${pct(t.fieldAccuracy)} | ${pct(t.reviewRate)} |`),
  '',
  '## Cases with errors',
  '',
  '| Case | Hard case | Expected | Outcome | Field errors |',
  '| --- | --- | --- | --- | --- |',
  ...reportCases
    .filter((c) => !c.correct)
    .map(
      (c) =>
        `| ${c.id} | ${c.hardCase ?? ''} | ${c.expected} | ${c.outcome} | ${c.fieldErrors.join('; ').replaceAll('|', '/')} |`,
    ),
  '',
  '## Search misses',
  '',
  ...(searches.filter((s) => !s.hit || !s.citedCorrectly).length
    ? searches
        .filter((s) => !s.hit || !s.citedCorrectly)
        .map(
          (s) =>
            `- ${s.question.id}${s.question.paraphrased ? ' (paraphrased)' : ''}: "${s.question.question}" expected ` +
            `${s.question.documentId} p.${s.question.page}, ${s.hit ? `found at rank ${s.rank}` : 'not in top 5'}; top result ${s.top}`,
        )
    : ['None.']),
  '',
  '## What was changed to improve these numbers',
  '',
  ...(changes.length ? changes.map((c) => `- ${c}`) : ['- Nothing yet.']),
  '',
  '## Method and limits',
  '',
  '- Field accuracy: every field defined for the document type, compared after normalisation (dates, amounts, ' +
    'names case- and punctuation-insensitive). A wrong document type counts all its fields as wrong.',
  '- Wrong-client filings: documents the system would file automatically to a client other than the true one ' +
    '(or at all, for the non-client document).',
  '- Review-queue rate: share of all documents sent to human review, including those policy requires.',
  '- Search hit rate: the source document appears in the top 5 passages. Citation accuracy: the top passage is ' +
    'from the source document and on the page holding the answer.',
  '- Scans are simulated with OCR-style character noise in the text layer; real image-only scans go to Claude as ' +
    'PDF (vision) and are not covered by this set yet.',
  '- The rules extractor is a regex baseline written alongside these templates, so its numbers on labelled ' +
    'layouts are optimistic; the prose and scan cases show where it breaks.',
  '',
].join('\n');

await writeFile(join(root, 'eval', 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(root, 'eval', 'report.md'), md);
console.log(md.split('\n## By document type')[0]);
console.log('\nWrote eval/report.md and eval/report.json');

if (args.has('check') && wrongClient > 0) {
  console.error(`FAIL: ${wrongClient} document(s) would be filed to the wrong client.`);
  process.exit(1);
}
