import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Extractor } from '../src/ai/extraction.js';
import { rulesExtractor } from '../src/ai/rules-extractor.js';
import { loadConfig, type JobsConfig } from '../src/config.js';
import type { Db } from '../src/db/index.js';
import { renderTextPdf } from '../src/documents/pdf-render.js';
import { getDocument, ingestDocument } from '../src/domain/documents.js';
import { createHttpApp } from '../src/http.js';
import { advance, backoffMs, claimNext, completeFiling, getJob, retryDead } from '../src/jobs/queue.js';
import { createWorker } from '../src/jobs/worker.js';
import type { AppServices } from '../src/services.js';
import { DOCUMENTS } from '../eval/dataset.js';
import { call, connectAs, demoDb, testServices, TOM, nb } from './helpers.js';

const JOBS: JobsConfig = { worker: false, concurrency: 1, maxAttempts: 3, backoffMs: 0, stuckSeconds: 60 };

/** Stores a document for batch intake (no text yet) and queues its job, as the upload route does. */
async function upload(db: Db, services: AppServices, pages: string[], name: string, key?: string) {
  const { id, jobId } = await ingestDocument(nb(db), services, {
    bytes: await renderTextPdf(name, pages),
    mimeType: 'application/pdf',
    filename: `${name}.pdf`,
    uploadedBy: 'st_maya',
    intakeJob: { createdBy: 'st_maya', batchId: null, idempotencyKey: key ?? null, maxAttempts: JOBS.maxAttempts },
  });
  return { documentId: id, job: { id: jobId! } };
}

const auditTools = async (db: Db, documentId: string) =>
  (
    await db.query<{ tool: string; outcome: string; staff_id: string }>(
      `select tool, outcome, staff_id from audit_log where input->>'documentId' = $1 order by id`,
      [documentId],
    )
  ).map((r) => `${r.tool}:${r.outcome}`);

describe('batch intake pipeline', () => {
  it('processes 10 documents in the background: each step audited, filed or reviewed by the usual rule', async () => {
    const services = testServices();
    const db = await demoDb();
    const docs = DOCUMENTS.filter((d) => d.clientId && d.hardCase === null).slice(0, 10);
    const uploaded = [];
    for (const d of docs) uploaded.push({ d, ...(await upload(db, services, d.pages, d.id)) });

    // Nothing is in the inbox while the jobs own the documents.
    const tom = await connectAs(db, TOM, services);
    expect((await call<{ documents: unknown[] }>(tom, 'list_inbox', {})).data.documents).toEqual([]);
    await tom.close();

    const worker = createWorker({ db, services, config: { ...JOBS, concurrency: 2 } });
    const steps = await worker.runUntilIdle();

    let filed = 0;
    for (const { d, documentId, job } of uploaded) {
      expect((await getJob(nb(db), job.id))?.status).toBe('done');
      const doc = (await getDocument(nb(db), documentId))!;
      if (doc.status === 'filed') {
        filed++;
        expect(doc.clientId).toBe(d.clientId); // never the wrong client
      } else {
        expect(doc.status).toBe('review');
      }
      expect(await auditTools(db, documentId)).toEqual([
        'job:text_extracted:ok',
        'job:embedded:ok',
        'job:fields_extracted:ok',
        'job:matched:ok',
        `job:${doc.status}:ok`,
        ...(doc.status === 'filed' ? ['job:reindexed:ok'] : []), // its passages now name the client
      ]);
    }
    expect(filed).toBeGreaterThanOrEqual(7);
    expect(steps).toBe(10 * 5 + filed); // text, embed, extract, match, decide; filed ones rebuild their passages
    const [note] = await db.query<{ n: number }>(`select count(*)::int as n from notes where kind = 'filing'`);
    expect(note?.n).toBe(filed);
    await db.close();
  }, 120_000);

  it('retries a failing step with backoff, then dead-letters it and hands the document back to the inbox', async () => {
    let calls = 0;
    const broken: Extractor = {
      name: 'broken',
      extract: async () => {
        calls++;
        throw new Error('model unavailable (503)');
      },
    };
    const services = testServices({ extractor: broken });
    const db = await demoDb();
    const { documentId, job } = await upload(db, services, ['INVOICE\nBill to: Acme Ltd\nTotal due: $10.00'], 'x');
    await createWorker({ db, services, config: JOBS }).runUntilIdle();

    expect(calls).toBe(3); // max attempts
    const dead = (await getJob(nb(db), job.id))!;
    expect(dead).toMatchObject({ status: 'dead', step: 'embedded', lastError: 'model unavailable (503)' });
    expect((await getDocument(nb(db), documentId))?.status).toBe('inbox');
    expect(await auditTools(db, documentId)).toEqual([
      'job:text_extracted:ok',
      'job:embedded:ok',
      'job:retry:error',
      'job:retry:error',
      'job:dead_letter:error',
    ]);
    await db.close();
  }, 60_000);

  it('waits exponentially longer between retries', async () => {
    expect([1, 2, 3, 4].map((a) => backoffMs(a, 2000))).toEqual([2000, 4000, 8000, 16000]);
    expect(backoffMs(30, 2000)).toBe(600_000);

    const services = testServices({
      extractor: { name: 'broken', extract: async () => Promise.reject(new Error('down')) },
    });
    const db = await demoDb();
    const { job } = await upload(db, services, ['INVOICE\nTotal due: $1.00'], 'y');
    const worker = createWorker({ db, services, config: { ...JOBS, backoffMs: 60_000 } });
    await worker.runUntilIdle(); // text, embed, then the first extraction failure
    const [row] = await db.query<{ status: string; waits: number }>(
      `select status, extract(epoch from run_at - now())::int as waits from jobs where id = $1`,
      [job.id],
    );
    expect(row?.status).toBe('queued');
    expect(row?.waits).toBeGreaterThan(50); // not due again for about a minute
    expect(await worker.tick()).toBe(false);
    await db.close();
  }, 60_000);

  it('reclaims a job whose worker stopped answering; the old worker can no longer record it', async () => {
    const services = testServices();
    const db = await demoDb();
    const { job } = await upload(db, services, ['INVOICE\nTotal due: $1.00'], 'z');

    const first = await claimNext(db, 'worker-a', JOBS);
    expect(first).toMatchObject({ id: job.id, status: 'running', attempts: 1 });
    expect(await claimNext(db, 'worker-b', JOBS)).toBeNull(); // locked: SKIP LOCKED / running

    await db.query(`update jobs set locked_at = now() - interval '1 hour' where id = $1`, [job.id]);
    const again = await claimNext(db, 'worker-b', JOBS);
    expect(again).toMatchObject({ id: job.id, attempts: 2 });
    expect(await advance(db, first!, 'text_extracted', false)).toBe(false);
    expect(await advance(db, again!, 'text_extracted', false)).toBe(true);
    await db.close();
  }, 60_000);

  it('dead-letters a job that was reclaimed too many times', async () => {
    const services = testServices();
    const db = await demoDb();
    const { job } = await upload(db, services, ['INVOICE\nTotal due: $1.00'], 'w');
    await db.query(
      `update jobs set status = 'running', attempts = 3, locked_at = now() - interval '1 hour' where id = $1`,
      [job.id],
    );
    await createWorker({ db, services, config: JOBS }).tick();
    expect(await getJob(nb(db), job.id)).toMatchObject({
      status: 'dead',
      lastError: expect.stringMatching(/stopped responding/),
    });
    await db.close();
  }, 60_000);

  it('stops at once, denied and audited, when the uploader is no longer a partner', async () => {
    const services = testServices();
    const db = await demoDb();
    const { documentId, job } = await upload(db, services, ['INVOICE\nTotal due: $1.00'], 'v');
    await db.query(`update staff set role = 'assistant' where id = 'st_maya'`);
    await createWorker({ db, services, config: JOBS }).runUntilIdle();
    expect(await getJob(nb(db), job.id)).toMatchObject({ status: 'dead', attempts: 1 });
    expect(await auditTools(db, documentId)).toEqual(['job:dead_letter:denied']);
    await db.close();
  }, 60_000);

  it('stores the document and its job together, or neither', async () => {
    const services = testServices();
    const db = await demoDb();
    await upload(db, services, ['A'.repeat(50)], 'u', 'key-12345678');
    // A second document under the same key: the job insert fails, so the document isn't stored either (before, it
    // stayed `processing` with no job, and uploading it again only said "already uploaded").
    await expect(upload(db, services, ['B'.repeat(50)], 'u2', 'key-12345678')).rejects.toThrow(/unique/);
    const [row] = await db.query<{ docs: number; jobs: number; orphans: number }>(
      `select (select count(*)::int from documents) as docs, (select count(*)::int from jobs) as jobs,
              (select count(*)::int from documents d where d.status = 'processing'
                 and not exists (select 1 from jobs j where j.document_id = d.id)) as orphans`,
    );
    expect(row).toEqual({ docs: 1, jobs: 1, orphans: 0 });
    await db.close();
  }, 60_000);

  it('two uploads of the same file at once give one document and one job', async () => {
    const services = testServices();
    const db = await demoDb();
    const [a, b] = await Promise.all([
      upload(db, services, ['C'.repeat(50)], 'same'),
      upload(db, services, ['C'.repeat(50)], 'same'),
    ]);
    expect(a.documentId).toBe(b.documentId);
    expect(await db.query('select 1 from jobs')).toHaveLength(1);
    await db.close();
  }, 60_000);

  describe('a worker that dies at the worst moment', () => {
    const INVOICE = [
      'Paperclip Co\nTAX INVOICE\nInvoice number: PC-1\nInvoice date: 2026-04-02\nBill to: Acme Ltd\nTotal due: $3.00',
    ];

    it('right after filing: the job resumes, stays filed, and nothing is written twice', async () => {
      const services = testServices();
      const db = await demoDb();
      const { documentId, job } = await upload(db, services, INVOICE, 'crash');
      const worker = createWorker({ db, services, config: JOBS });
      while ((await getJob(nb(db), job.id))?.step !== 'filed') expect(await worker.tick()).toBe(true);
      // Filed, and the worker dies before rebuilding the passages: the next worker claims it and dies too.
      expect(await claimNext(db, 'dying', JOBS)).toMatchObject({ id: job.id, step: 'filed' });
      await db.query(`update jobs set locked_at = now() - interval '1 hour' where id = $1`, [job.id]);

      await createWorker({ db, services, config: JOBS }).runUntilIdle();
      expect(await getJob(nb(db), job.id)).toMatchObject({ status: 'done', step: 'filed' });
      expect(await getDocument(nb(db), documentId)).toMatchObject({ status: 'filed', clientId: 'cl_acme' });
      expect(await db.query(`select 1 from notes where kind = 'filing'`)).toHaveLength(1);
      expect((await auditTools(db, documentId)).filter((t) => t === 'job:filed:ok')).toHaveLength(1);
      const [chunk] = await db.query<{ content: string }>(
        'select content from document_chunks where document_id = $1',
        [documentId],
      );
      expect(chunk?.content).toContain('Acme Ltd |'); // the passages know the client
      await db.close();
    }, 60_000);

    it('a worker that lost its job can no longer file the document', async () => {
      const services = testServices();
      const db = await demoDb();
      const { documentId, job } = await upload(db, services, INVOICE, 'lost');
      const first = (await claimNext(db, 'worker-a', JOBS))!;
      await db.query(`update jobs set locked_at = now() - interval '1 hour' where id = $1`, [job.id]);
      await claimNext(db, 'worker-b', JOBS);
      const filed = await completeFiling(nb(db), first, {
        clientId: 'cl_acme',
        taxYear: 2026,
        docType: 'invoice',
        title: 'x',
        note: 'x',
        detail: 'x',
      });
      expect(filed).toBe(false);
      expect((await getDocument(nb(db), documentId))?.status).toBe('processing');
      expect(await db.query('select 1 from notes where kind = $1', ['filing'])).toHaveLength(0);
      expect((await auditTools(db, documentId)).filter((t) => t.startsWith('job:filed'))).toEqual([]);
      await db.close();
    }, 60_000);

    it('a failure reported by a worker that lost its job changes nothing and is not audited', async () => {
      const db = await demoDb();
      const services = testServices({
        // The extraction outlasts the stuck timeout: another worker takes the job before this one fails.
        extractor: {
          name: 'slow',
          extract: async () => {
            await db.query(`update jobs set locked_by = 'worker-b'`);
            throw new Error('too late');
          },
        },
      });
      const { documentId, job } = await upload(db, services, INVOICE, 'late');
      const worker = createWorker({ db, services, config: JOBS });
      for (let i = 0; i < 3; i++) await worker.tick(); // text, embed, extraction
      expect(await getJob(nb(db), job.id)).toMatchObject({ status: 'running', lastError: null });
      expect((await auditTools(db, documentId)).filter((t) => /retry|dead/.test(t))).toEqual([]);
      await db.close();
    }, 60_000);

    it('dead-lettering always hands the document back with it, and a retry takes both or neither', async () => {
      const broken = testServices({ extractor: { name: 'broken', extract: () => Promise.reject(new Error('down')) } });
      const db = await demoDb();
      const { documentId, job } = await upload(db, broken, INVOICE, 'dead');
      await createWorker({ db, services: broken, config: JOBS }).runUntilIdle();
      const stuck = `select 1 from jobs j join documents d on d.id = j.document_id where j.status = 'dead' and d.status = 'processing'`;
      expect(await db.query(stuck)).toEqual([]);

      // Someone filed it by hand meanwhile: the retry is refused and the job stays dead.
      await db.query(`update documents set status = 'review' where id = $1`, [documentId]);
      expect(await retryDead(nb(db), job.id)).toBeNull();
      expect((await getJob(nb(db), job.id))?.status).toBe('dead');

      await db.query(`update documents set status = 'inbox' where id = $1`, [documentId]);
      expect(await retryDead(nb(db), job.id)).toMatchObject({ status: 'queued', attempts: 0 });
      expect((await getDocument(nb(db), documentId))?.status).toBe('processing');
      await db.close();
    }, 60_000);
  });
});

describe('batch intake API', () => {
  let db: Db;
  let services: AppServices;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    services = testServices({ extractor: rulesExtractor() });
    db = await demoDb();
    const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', DEMO_LOGIN: 'true', JOB_BACKOFF_MS: '0' });
    const app = createHttpApp({ db, config, services, projectRoot: '/nonexistent' });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });

  const req = (path: string, user: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { 'x-clientdesk-user': user, 'x-clientdesk-csrf': '1', ...(init.headers as Record<string, string>) },
    });
  const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const file = (text: string, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-filename': 'f.txt', ...headers },
    body: text,
  });
  const lastAuditRow = async () =>
    (
      await db.query<{ tool: string; outcome: string; staff_id: string }>(
        'select tool, outcome, staff_id from audit_log order by id desc limit 1',
      )
    )[0];

  it('is for partners only: assistants are refused and audited', async () => {
    expect((await req('/api/batches', TOM, json({ total: 2 }))).status).toBe(403);
    expect(await lastAuditRow()).toMatchObject({
      tool: 'dashboard:create_batch',
      outcome: 'denied',
      staff_id: 'st_tom',
    });
    expect((await req('/api/jobs?status=dead', TOM)).status).toBe(403);
    expect(await lastAuditRow()).toMatchObject({ tool: 'dashboard:view_jobs', outcome: 'denied' });
  });

  it('refuses the read-only demo visitor', async () => {
    const res = await req('/api/batches', 'demo@northbridge.example', json({ total: 2 }));
    expect(res.status).toBe(403);
    expect(await lastAuditRow()).toMatchObject({
      tool: 'dashboard:create_batch',
      outcome: 'denied',
      staff_id: 'st_demo',
    });
  });

  it('uploads files to a batch, replays an idempotent retry, and reports per-document progress', async () => {
    const MAYA = 'maya@northbridge.example';
    const { id } = (await (await req('/api/batches', MAYA, json({ total: 2 }))).json()) as { id: string };
    const a = await req(
      `/api/batches/${id}/files`,
      MAYA,
      file('INVOICE\nBill to: Acme Ltd\nTotal due: $5.00', { 'idempotency-key': 'file-a-0001' }),
    );
    const first = (await a.json()) as { documentId: string; jobId: number };
    const replay = (await (
      await req(
        `/api/batches/${id}/files`,
        MAYA,
        file('INVOICE\nBill to: Acme Ltd\nTotal due: $5.00', { 'idempotency-key': 'file-a-0001' }),
      )
    ).json()) as { jobId: number };
    expect(replay.jobId).toBe(first.jobId);
    await req(`/api/batches/${id}/files`, MAYA, file('Something else entirely, not an invoice at all.'));
    expect((await req(`/api/batches/${id}/files`, MAYA, file('A third file that does not fit'))).status).toBe(409);

    const before = (await (await req(`/api/batches/${id}`, MAYA)).json()) as {
      items: { status: string; step: string }[];
    };
    expect(before.items.map((i) => [i.status, i.step])).toEqual([
      ['queued', 'stored'],
      ['queued', 'stored'],
    ]);

    await createWorker({ db, services, config: loadConfig({ NODE_ENV: 'test' }).jobs }).runUntilIdle();
    const after = (await (await req(`/api/batches/${id}`, MAYA)).json()) as {
      items: { status: string; outcome: { kind: string } | null }[];
    };
    expect(after.items.every((i) => i.status === 'done' && i.outcome !== null)).toBe(true);
  }, 60_000);

  it('answers a file it already has as a duplicate: no job, no second document, audited', async () => {
    const MAYA = 'maya@northbridge.example';
    const { id } = (await (await req('/api/batches', MAYA, json({ total: 2 }))).json()) as { id: string };
    const text = 'INVOICE\nInvoice number: DUP-1\nBill to: Acme Ltd\nTotal due: $6.00';
    const first = (await (await req(`/api/batches/${id}/files`, MAYA, file(text))).json()) as { documentId: string };
    const again = await req(`/api/batches/${id}/files`, MAYA, file(text, { 'x-filename': 'renamed.txt' }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ documentId: first.documentId, jobId: null, duplicate: true });
    expect(await lastAuditRow()).toMatchObject({ tool: 'dashboard:batch_upload', outcome: 'ok', staff_id: 'st_maya' });
    const batch = (await (await req(`/api/batches/${id}`, MAYA)).json()) as { total: number; items: unknown[] };
    expect(batch.total).toBe(2);
    expect(batch.items).toHaveLength(1); // the dashboard accounts for the duplicate itself
  }, 60_000);

  it('lets a partner retry a dead job once the cause is fixed', async () => {
    const broken = testServices({ extractor: { name: 'broken', extract: () => Promise.reject(new Error('down')) } });
    const { documentId, job } = await upload(db, broken, ['INVOICE\nBill to: Acme Ltd\nTotal due: $7.00'], 'retry-me');
    await createWorker({ db, services: broken, config: JOBS }).runUntilIdle();
    expect((await getJob(nb(db), job.id))?.status).toBe('dead');

    const dead = (await (await req('/api/jobs?status=dead', 'maya@northbridge.example')).json()) as {
      items: { jobId: number }[];
    };
    expect(dead.items.map((i) => i.jobId)).toContain(job.id);

    expect((await req(`/api/jobs/${job.id}/retry`, 'maya@northbridge.example', { method: 'POST' })).status).toBe(200);
    expect((await getDocument(nb(db), documentId))?.status).toBe('processing');
    await createWorker({ db, services, config: JOBS }).runUntilIdle();
    expect((await getJob(nb(db), job.id))?.status).toBe('done');
    expect((await req(`/api/jobs/${job.id}/retry`, 'maya@northbridge.example', { method: 'POST' })).status).toBe(404);
  }, 60_000);
});
