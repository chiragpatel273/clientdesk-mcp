import type Anthropic from '@anthropic-ai/sdk';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeExtractor, LARGE_MODEL, SMALL_MODEL } from '../src/ai/claude-extractor.js';
import { EMBEDDING_DIMS, voyageEmbedder } from '../src/ai/embeddings.js';
import { FIELDS } from '../src/ai/extraction.js';
import { GROQ_LARGE_MODEL, GROQ_SMALL_MODEL, groqExtractor } from '../src/ai/groq-extractor.js';
import { estimateCost } from '../src/ai/prices.js';
import { reportCall, usageScope, type LlmCall } from '../src/ai/usage.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/index.js';
import { renderTextPdf } from '../src/documents/pdf-render.js';
import { ingestDocument } from '../src/domain/documents.js';
import { usageSummary } from '../src/domain/usage.js';
import { createHttpApp } from '../src/http.js';
import { enqueue } from '../src/jobs/queue.js';
import { createWorker } from '../src/jobs/worker.js';
import { call, connectAs, demoDb, demoDbWithDocuments, lastAudit, testServices, TOM, nb } from './helpers.js';

type Recorded = LlmCall & { costUsd: number };
const input = { filename: 'inv.pdf', pages: ['INVOICE\nBilled to: Acme Ltd'], textLayer: true, pdf: null };

/** Collects the calls `fn` reports, without a database. */
async function collect(fn: () => Promise<unknown>): Promise<Recorded[]> {
  const calls: Recorded[] = [];
  await usageScope({ listener: (c) => calls.push(c) }, fn).catch(() => undefined);
  return calls;
}

const llmRows = (db: Db) =>
  db.query<Record<string, unknown>>(
    `select staff_id, source, operation, provider, model, input_tokens, output_tokens, tokens_estimated,
            cost_usd::float8 as cost, escalated, success, error, document_id, job_id::int as job_id
     from llm_calls order by id`,
  );

describe('prices', () => {
  it('estimates cost per million tokens, and says when a model is unknown', () => {
    expect(estimateCost('claude-opus-5-5', 1_000_000, 100_000)).toEqual({ usd: 6, known: true });
    expect(estimateCost('openai/gpt-oss-20b', 2_000, 500).usd).toBeCloseTo(0.0003, 6);
    expect(estimateCost('local-hash-v1', 5_000, 0)).toEqual({ usd: 0, known: true });
    expect(estimateCost('mystery-model', 10, 10)).toEqual({ usd: 0, known: false });
  });
});

describe('recording model calls', () => {
  it('records nothing outside a usage scope, and never throws', async () => {
    await expect(
      reportCall({
        operation: 'embed',
        provider: 'local',
        model: 'x',
        inputTokens: 1,
        outputTokens: 0,
        latencyMs: 1,
        success: true,
      }),
    ).resolves.toBeUndefined();
    // A database that fails every query: the call still resolves.
    const db = {
      firmId: 'firm_northbridge',
      query: async () => {
        throw new Error('connection lost');
      },
    } as unknown as Db;
    await expect(
      usageScope({ db }, () =>
        reportCall({
          operation: 'embed',
          provider: 'local',
          model: 'x',
          inputTokens: 1,
          outputTokens: 0,
          latencyMs: 1,
          success: true,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('records Groq tokens from the API, the escalation, and the cost', async () => {
    const answer = (confidence: number) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  doc_type: 'invoice',
                  doc_type_confidence: 0.98,
                  client_name: 'Acme Ltd',
                  tax_year: 2026,
                  fields: FIELDS.invoice.map((f) => ({ name: f.name, value: null, confidence })),
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1200, completion_tokens: 300 },
        }),
      );
    const queue = [answer(0.5), answer(0.99)]; // unsure → escalates
    const extractor = groqExtractor({ apiKey: 't', fetch: (async () => queue.shift()!) as typeof fetch });
    const calls = await collect(() => extractor.extract(input));
    expect(calls).toMatchObject([
      {
        operation: 'extract',
        provider: 'groq',
        model: GROQ_SMALL_MODEL,
        inputTokens: 1200,
        outputTokens: 300,
        escalated: false,
        success: true,
      },
      { model: GROQ_LARGE_MODEL, escalated: true, success: true },
    ]);
    expect(calls[0]!.costUsd).toBeCloseTo((1200 * 0.075 + 300 * 0.3) / 1e6, 9);
  });

  it('records a failed call with its error, and no document text', async () => {
    const extractor = groqExtractor({
      apiKey: 't',
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as typeof fetch,
    });
    const calls = await collect(() => extractor.extract(input));
    expect(calls[0]).toMatchObject({ success: false, error: 'Groq 401', inputTokens: 0 });
    expect(JSON.stringify(calls)).not.toContain('Billed to');
    expect(JSON.stringify(calls)).not.toContain('bad key'); // the provider's message can echo model output
  });

  it('records Claude tokens (cache reads counted as input) for both models', async () => {
    const parsed = (confidence: number) => ({
      stop_reason: 'end_turn',
      parsed_output: {
        doc_type: 'invoice',
        doc_type_confidence: 0.99,
        client_name: 'Acme Ltd',
        tax_year: 2026,
        fields: FIELDS.invoice.map((f) => ({ name: f.name, value: null, confidence })),
      },
      usage: { input_tokens: 900, output_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    });
    const answers = [parsed(0.4), parsed(0.99)];
    const client = { beta: { messages: { parse: async () => answers.shift() } } } as unknown as Anthropic;
    const calls = await collect(() => claudeExtractor({ client }).extract(input));
    expect(calls).toMatchObject([
      { provider: 'anthropic', model: SMALL_MODEL, inputTokens: 1000, outputTokens: 200, escalated: false },
      { model: LARGE_MODEL, escalated: true },
    ]);
    expect(calls[1]!.costUsd).toBeCloseTo((1000 * 4 + 200 * 20) / 1e6, 9);
  });

  it('records Voyage tokens per batch', async () => {
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: body.input.map((_, index) => ({ index, embedding: new Array(EMBEDDING_DIMS).fill(0.1) })),
          usage: { total_tokens: 42 },
        }),
      );
    }) as typeof fetch;
    const calls = await collect(() => voyageEmbedder('k', undefined, fakeFetch).embed(['a', 'b'], 'document'));
    expect(calls).toMatchObject([{ operation: 'embed', provider: 'voyage', model: 'voyage-3.5', inputTokens: 42 }]);
  });

  it('records offline models with estimated tokens and cost 0', async () => {
    const services = testServices();
    const calls = await collect(async () => {
      await services.extractor.extract(input);
      await services.embedder.embed(['a passage of forty characters, roughly.'], 'document');
    });
    expect(calls).toMatchObject([
      { operation: 'extract', provider: 'local', model: 'rules-v1', tokensEstimated: true, costUsd: 0 },
      { operation: 'embed', provider: 'local', model: 'local-hash-v1', inputTokens: 10, tokensEstimated: true },
    ]);
  });
});

describe('who and what a call is recorded against', () => {
  it('an MCP tool call: the staff member, source mcp and the document', async () => {
    const services = testServices();
    const db = await demoDbWithDocuments(services);
    await db.query('delete from llm_calls');
    await db.query('update documents set extraction = null where id = $1', ['doc_inbox_northwind']);
    const tom = await connectAs(db, TOM, services);
    await call(tom, 'extract_document', { documentId: 'doc_inbox_northwind' });
    await tom.close();
    expect(await llmRows(db)).toEqual([
      expect.objectContaining({
        staff_id: 'st_tom',
        source: 'mcp',
        operation: 'extract',
        model: 'rules-v1',
        document_id: 'doc_inbox_northwind',
        success: true,
      }),
    ]);
    await db.close();
  }, 60_000);

  it('a batch job: the uploader, source job, the document and the job', async () => {
    const services = testServices();
    const db = await demoDb();
    const { id } = await ingestDocument(nb(db), services, {
      bytes: await renderTextPdf('x', ['INVOICE\nInvoice number: Q-1\nBill to: Acme Ltd\nTotal due: $9.00']),
      mimeType: 'application/pdf',
      filename: 'x.pdf',
      uploadedBy: 'st_maya',
      deferProcessing: true,
    });
    const { job } = await enqueue(nb(db), { documentId: id, createdBy: 'st_maya' }, { maxAttempts: 3 });
    await createWorker({ db, services, config: loadConfig({ NODE_ENV: 'test' }).jobs }).runUntilIdle();
    const rows = await llmRows(db);
    expect(rows.length).toBeGreaterThanOrEqual(2); // index + extract (+ re-index when filed)
    expect(
      rows.every((r) => r.source === 'job' && r.staff_id === 'st_maya' && r.document_id === id && r.job_id === job.id),
    ).toBe(true);
    expect(rows.map((r) => r.operation)).toContain('extract');

    const summary = await usageSummary(nb(db), 14);
    expect(summary.totals.calls).toBe(rows.length);
    expect(summary.totals.costUsd).toBe(0);
    expect(summary.byModel.map((m) => m.model).sort()).toEqual(['local-hash-v1', 'rules-v1']);
    expect(summary.bySource).toEqual([{ source: 'job', calls: rows.length, costUsd: 0 }]);
    await db.close();
  }, 60_000);

  it('summarises cost per filed document, escalation and error rates', async () => {
    const db = await demoDb();
    const add = (c: Partial<LlmCall>) =>
      usageScope({ db: nb(db), source: 'mcp' }, () =>
        reportCall({
          operation: 'extract',
          provider: 'anthropic',
          model: 'claude-haiku-5-5',
          inputTokens: 1_000_000,
          outputTokens: 0,
          latencyMs: 100,
          success: true,
          ...c,
        }),
      );
    await add({});
    await add({});
    await add({ model: 'claude-opus-5-5', escalated: true, latencyMs: 400 });
    await add({ success: false, inputTokens: 0 });
    const s = await usageSummary(nb(db), 7);
    expect(s.totals).toMatchObject({
      calls: 4,
      costUsd: 0.1 + 0.1 + 4,
      avgLatencyMs: 175,
      escalationRate: 1 / 3,
      errorRate: 0.25,
      filedDocuments: 0,
      costPerFiledDocument: null,
    });
    await db.close();
  }, 30_000);
});

describe('/api/usage', () => {
  let db: Db;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    db = await demoDb();
    const app = createHttpApp({
      db,
      config: loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', DEMO_LOGIN: 'true' }),
      services: testServices(),
      projectRoot: '/nonexistent',
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

  const get = (user: string) => fetch(`${base}/api/usage?days=7`, { headers: { 'x-clientdesk-user': user } });

  it('is for partners: an assistant is refused and audited', async () => {
    expect((await get(TOM)).status).toBe(403);
    expect(await lastAudit(db)).toMatchObject({ staff_id: 'st_tom', tool: 'dashboard:view_usage', outcome: 'denied' });
  });

  it('answers partners and the read-only demo visitor', async () => {
    const maya = (await (await get('maya@northbridge.example')).json()) as { days: number; evalRuns: unknown[] };
    expect(maya).toMatchObject({ days: 7, evalRuns: [] });
    expect((await get('demo@northbridge.example')).status).toBe(200);
  });
});
