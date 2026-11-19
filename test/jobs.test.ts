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
import { backoffMs, claimNext, enqueue, getJob, advance } from '../src/jobs/queue.js';
import { createWorker } from '../src/jobs/worker.js';
import type { AppServices } from '../src/services.js';
import { DOCUMENTS } from '../eval/dataset.js';
import { call, connectAs, demoDb, testServices, TOM, nb } from './helpers.js';

const JOBS: JobsConfig = { worker: false, concurrency: 1, maxAttempts: 3, backoffMs: 0, stuckSeconds: 60 };

/** Stores a document for batch intake (no text yet) and queues its job, as the upload route does. */
async function upload(db: Db, services: AppServices, pages: string[], name: string, key?: string) {
  const { id } = await ingestDocument(nb(db), services, {
    bytes: await renderTextPdf(name, pages),
    mimeType: 'application/pdf',
    filename: `${name}.pdf`,
    uploadedBy: 'st_maya',
    deferProcessing: true,
  });
  const { job } = await enqueue(nb(db), { documentId: id, createdBy: 'st_maya', idempotencyKey: key }, JOBS);
  return { documentId: id, job };
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
    expect(steps).toBe(10 * 5); // text, embed, extract, match, decide

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
      ]);
    }
    expect(filed).toBeGreaterThanOrEqual(7);
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
    expect(await advance(db, first!, 'worker-a', 'text_extracted', false)).toBe(false);
    expect(await advance(db, again!, 'worker-b', 'text_extracted', false)).toBe(true);
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

  it('enqueues once per idempotency key', async () => {
    const services = testServices();
    const db = await demoDb();
    const { documentId, job } = await upload(db, services, ['A'.repeat(50)], 'u', 'key-12345678');
    const second = await enqueue(nb(db), { documentId, createdBy: 'st_maya', idempotencyKey: 'key-12345678' }, JOBS);
    expect(second).toMatchObject({ created: false, job: { id: job.id } });
    await db.close();
  }, 60_000);
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
