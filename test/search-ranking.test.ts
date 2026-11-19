import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMBEDDING_DIMS, localEmbedder, voyageEmbedder, type Embedder } from '../src/ai/embeddings.js';
import type { Extraction } from '../src/ai/extraction.js';
import { rulesExtractor } from '../src/ai/rules-extractor.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/index.js';
import { renderTextPdf } from '../src/documents/pdf-render.js';
import {
  getDocument,
  ingestDocument,
  PASSAGE_VERSION,
  passageContext,
  reindexStale,
  type DocumentRecord,
} from '../src/domain/documents.js';
import { rerankPages, searchDocuments } from '../src/domain/search.js';
import { createHttpApp } from '../src/http.js';
import { demoDb, testServices, nb } from './helpers.js';

const STATEMENT = [
  [
    'Meridian Trust Bank',
    'ACCOUNT STATEMENT',
    'Account holder: Lakeside Dental Group',
    'Account number: ****9950',
    'Statement period: 1 March 2026 to 31 March 2026',
    'Opening balance: $85,895.40',
    '03/03/2026  Deposit  $6,075.15',
  ].join('\n'),
  ['Meridian Trust Bank - statement page 2', 'Closing balance: $90,677.03', 'Currency: USD'].join('\n'),
];

async function statementExtraction(): Promise<Extraction> {
  return rulesExtractor().extract({ filename: null, pages: STATEMENT, textLayer: true, pdf: null });
}

describe('passage context', () => {
  const doc = (extraction: Extraction | null): DocumentRecord =>
    ({
      title: 'Meridian Trust Bank statement 2026-03-01 to 2026-03-31',
      clientName: 'Lakeside Dental Group',
      extraction,
    }) as DocumentRecord;

  it('repeats key identifiers on every page and lists the fields a page holds by description', async () => {
    const extraction = await statementExtraction();
    const page2 = passageContext(doc(extraction), STATEMENT[1]!, 2);
    expect(page2.split('\n')[0]).toBe(
      'Meridian Trust Bank statement 2026-03-01 to 2026-03-31 | Lakeside Dental Group | bank statement | account ****9950 | page 2',
    );
    expect(page2).toContain('balance at the end of the period');
    expect(page2).not.toContain('balance at the start of the period'); // the opening balance is on page 1
    const page1 = passageContext(doc(extraction), STATEMENT[0]!, 1);
    expect(page1).toContain('balance at the start of the period');
    expect(page1).not.toContain('balance at the end of the period');
  });

  it('never copies a description’s examples into passages', () => {
    const extraction: Extraction = {
      docType: 'tax_form',
      docTypeConfidence: 1,
      clientName: 'Hana Kim',
      taxYear: 2025,
      fields: [{ name: 'form_type', value: '1098', confidence: 1 }],
      model: 'test',
    };
    const text = passageContext(
      { title: 'Form 1098 2025', clientName: 'Hana Kim', extraction } as DocumentRecord,
      'Form 1098',
      1,
    );
    expect(text).toContain('form name');
    expect(text).not.toMatch(/1099|W-2/); // "Form name, e.g. 1099-INT, 1099-DIV, W-2, 1098"
  });

  it('writes only the document line without an extraction', () => {
    expect(passageContext(doc(null), STATEMENT[1]!, 2)).toBe(
      'Meridian Trust Bank statement 2026-03-01 to 2026-03-31 | Lakeside Dental Group | page 2',
    );
  });
});

describe('rerankPages', () => {
  const r = (id: string, documentId: string, content: string, score: number) => ({ id, documentId, content, score });

  it('cites the page holding the words that tell the document’s pages apart', () => {
    const ranked = [
      r('a1', 'a', 'Lakeside Dental Group Meridian account 9950 statement period opening balance', 0.06),
      r('a2', 'a', 'Lakeside Dental Group Meridian account 9950 balance at the end of the period', 0.05),
      r('b1', 'b', 'Another statement for Lakeside Dental Group', 0.03),
    ];
    const out = rerankPages('What did Lakeside Dental Group have left at the end of the period?', ranked);
    expect(out.map((x) => x.id)).toEqual(['a2', 'a1', 'b1']);
    expect(out.map((x) => x.score)).toEqual([0.06, 0.05, 0.03]); // slots keep their scores: still sorted
  });

  it('never moves documents, so the hit rate cannot change', () => {
    const ranked = [
      r('a1', 'a', 'acme invoice', 0.06),
      r('b1', 'b', 'closing balance end period', 0.05),
      r('a2', 'a', 'acme invoice total due end', 0.04),
    ];
    const out = rerankPages('acme total due at the end', ranked);
    expect(out.map((x) => x.documentId)).toEqual(['a', 'b', 'a']);
    expect(out[0]!.id).toBe('a2');
  });

  it('keeps the fused order when no words tell the pages apart', () => {
    const ranked = [r('a1', 'a', 'acme invoice', 0.06), r('a2', 'a', 'acme invoice', 0.05)];
    expect(rerankPages('acme invoice', ranked).map((x) => x.id)).toEqual(['a1', 'a2']);
  });
});

describe('search with v2 passages', () => {
  let db: Db;
  const services = testServices();

  beforeAll(async () => {
    db = await demoDb();
    await ingestDocument(nb(db), services, {
      id: 'doc_stmt',
      bytes: await renderTextPdf('statement', STATEMENT),
      mimeType: 'application/pdf',
      filename: 'stmt.pdf',
      title: 'Meridian Trust Bank statement 2026-03-01 to 2026-03-31',
      uploadedBy: null,
      extraction: await statementExtraction(),
      filed: { clientId: 'cl_lakeside', taxYear: 2026, docType: 'bank_statement', staffId: null },
    });
  });

  afterAll(async () => {
    await db.close();
  });

  it('cites page 2 for a paraphrased question about the closing balance', async () => {
    const passages = await searchDocuments(
      nb(db),
      services.embedder,
      'What did Lakeside Dental Group have left in the Meridian Trust Bank account ending 9950 at the end of the period?',
      { allowedClientIds: 'all', limit: 5 },
    );
    expect(passages[0]).toMatchObject({ documentId: 'doc_stmt', page: 2 });
  });

  it('still returns nothing outside the caller’s clients', async () => {
    const passages = await searchDocuments(nb(db), services.embedder, 'closing balance Lakeside', {
      allowedClientIds: ['cl_acme'],
      limit: 5,
    });
    expect(passages).toEqual([]);
  });

  it('rebuilds stale passages on start-up: another embedder or an older format', async () => {
    expect(await reindexStale(nb(db), services.embedder)).toBe(0);

    await db.query(`update document_chunks set passage_version = 1 where document_id = 'doc_stmt'`);
    expect(await reindexStale(nb(db), services.embedder)).toBe(1);
    const [row] = await db.query<{ v: number }>(
      `select min(passage_version)::int as v from document_chunks where document_id = 'doc_stmt'`,
    );
    expect(row?.v).toBe(PASSAGE_VERSION);

    const other: Embedder = { model: 'other-model', embed: (texts, kind) => localEmbedder().embed(texts, kind) };
    expect(await reindexStale(nb(db), other)).toBe(1);
    const models = await db.query<{ embedding_model: string }>(
      `select distinct embedding_model from document_chunks where document_id = 'doc_stmt'`,
    );
    expect(models).toEqual([{ embedding_model: 'other-model' }]);
    expect((await getDocument(nb(db), 'doc_stmt'))?.extraction?.docType).toBe('bank_statement');
  });
});

describe('Voyage embedder (no network: a fake fetch)', () => {
  const vector = () => Array.from({ length: EMBEDDING_DIMS }, () => 0.01);

  it('sends input_type and 1024 dimensions, and batches 64 texts per request', async () => {
    const bodies: { input: string[]; input_type: string; output_dimension: number; model: string }[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return new Response(
        JSON.stringify({ data: body.input.map((_: string, index: number) => ({ index, embedding: vector() })) }),
      );
    }) as typeof fetch;
    const embedder = voyageEmbedder('key', undefined, fakeFetch);
    const out = await embedder.embed(
      Array.from({ length: 70 }, (_, i) => `text ${i}`),
      'query',
    );
    expect(out).toHaveLength(70);
    expect(bodies.map((b) => b.input.length)).toEqual([64, 6]);
    expect(bodies[0]).toMatchObject({ model: 'voyage-3.5', input_type: 'query', output_dimension: 1024 });
    expect(embedder.model).toBe('voyage-3.5');
  });

  it('fails loudly on an error or a malformed answer', async () => {
    const failing = voyageEmbedder('key', undefined, (async () => new Response('', { status: 429 })) as typeof fetch);
    await expect(failing.embed(['x'], 'document')).rejects.toThrow('Voyage embeddings failed (429)');
    const short = voyageEmbedder(
      'key',
      undefined,
      (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }))) as typeof fetch,
    );
    await expect(short.embed(['x'], 'document')).rejects.toThrow('unexpected number or size');
  });

  it('is the embedder whenever VOYAGE_API_KEY is set', () => {
    expect(loadConfig({ NODE_ENV: 'test', VOYAGE_API_KEY: 'k' }).embeddings).toBe('voyage');
    expect(loadConfig({ NODE_ENV: 'test' }).embeddings).toBe('local');
  });
});

describe('/api/accuracy runs', () => {
  let server: Server;
  let base: string;
  let db: Db;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'clientdesk-eval-'));
    mkdirSync(join(root, 'eval'));
    writeFileSync(join(root, 'eval', 'baseline.json'), JSON.stringify({ extractor: 'rules-v1' }));
    db = await demoDb();
    const app = createHttpApp({
      db,
      config: loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev' }),
      services: testServices(),
      projectRoot: root,
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });

  it('serves the model run, the baseline on request, and falls back to the baseline', async () => {
    // Only the baseline exists at first; then a model run is published.
    expect(await (await fetch(`${base}/api/accuracy`)).json()).toEqual({ extractor: 'rules-v1' });
    writeFileSync(join(root, 'eval', 'report.json'), JSON.stringify({ extractor: 'groq' }));
    expect(await (await fetch(`${base}/api/accuracy`)).json()).toEqual({ extractor: 'groq' });
    expect(await (await fetch(`${base}/api/accuracy?run=baseline`)).json()).toEqual({ extractor: 'rules-v1' });
  });
});
