import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Extractor } from '../src/ai/extraction.js';
import { localEmbedder } from '../src/ai/embeddings.js';
import { rulesExtractor } from '../src/ai/rules-extractor.js';
import { loadConfig, type JobsConfig } from '../src/config.js';
import type { Db } from '../src/db/index.js';
import { extractPlainText } from '../src/documents/text.js';
import { chunkPages, getDocument, ingestDocument, reindexDocument, reindexStale } from '../src/domain/documents.js';
import { createHttpApp } from '../src/http.js';
import { advance, claimNext, createBatch, getJob } from '../src/jobs/queue.js';
import { createWorker } from '../src/jobs/worker.js';
import type { AppServices } from '../src/services.js';
import { memoryFileStore } from '../src/storage/files.js';
import { clientKey } from '../src/web/rate-limit.js';
import {
  ANA,
  call,
  connectAs,
  demoDb,
  demoDbWithDocuments,
  HL,
  LENA,
  MAYA,
  nb,
  NB,
  testServices,
  TOM,
} from './helpers.js';

/**
 * Regression tests for the v2 security review (2026-11-24), following the reviewer's reproductions. Most were proved
 * against the old code by the reviewer; they were written here together with the fixes, not run against the old code.
 */

const JOBS: JobsConfig = { worker: false, concurrency: 1, maxAttempts: 3, backoffMs: 0, stuckSeconds: 60 };
const DEMO = 'demo@northbridge.example';
const MARLOW =
  'TAX INVOICE\nFrom: Paper Co\nInvoice number: MS-1\nInvoice date: 2026-04-02\nBill to: Marlow Studio LLC\nTotal due: $3.00';
const ACME = MARLOW.replace('Marlow Studio LLC', 'Acme Ltd').replace('MS-1', 'AC-1');

async function serve(db: Db, services: AppServices) {
  const app = createHttpApp({
    db,
    config: loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', DEMO_LOGIN: 'true' }),
    services,
    projectRoot: '/nonexistent',
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    api: (path: string, user: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { 'x-clientdesk-user': user, 'x-clientdesk-csrf': '1', ...(init.headers as Record<string, string>) },
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const batchDoc = (db: Db, services: AppServices, text: string, name = 'f.txt') =>
  ingestDocument(nb(db), services, {
    bytes: new TextEncoder().encode(text),
    mimeType: 'text/plain',
    filename: name,
    uploadedBy: 'st_maya',
    intakeJob: { createdBy: 'st_maya', batchId: null, idempotencyKey: null, maxAttempts: JOBS.maxAttempts },
  });

const inboxDoc = (db: Db, services: AppServices, text: string, name = 'f.txt') =>
  ingestDocument(nb(db), services, {
    bytes: new TextEncoder().encode(text),
    mimeType: 'text/plain',
    filename: name,
    uploadedBy: 'st_maya',
  });

const newest = async (db: Db, firm = NB) =>
  (
    await db.query<{ staff_id: string; tool: string; outcome: string; detail: string | null }>(
      'select staff_id, tool, outcome, detail from audit_log where firm_id = $1 order by id desc limit 1',
      [firm],
    )
  )[0];

function counting(inner: Extractor = rulesExtractor()) {
  const state = { calls: 0 };
  const extractor: Extractor = {
    name: 'counting',
    extract: async (input) => {
      state.calls++;
      await new Promise((r) => setTimeout(r, 50));
      return inner.extract(input);
    },
  };
  return { extractor, state };
}

describe('a document being processed by batch intake', () => {
  it('can’t be opened, extracted or matched by anyone, so nobody can disturb the job', async () => {
    const services = testServices();
    const db = await demoDb();
    const web = await serve(db, services);
    const { id, jobId } = await batchDoc(db, services, ACME);
    for (const user of [DEMO, MAYA, TOM]) {
      expect((await web.api(`/api/documents/${id}/file`, user)).status, user).toBe(409);
      expect(await newest(db), user).toMatchObject({ tool: 'dashboard:view_document', outcome: 'denied' });
    }
    const maya = await connectAs(db, MAYA, services);
    for (const tool of ['extract_document', 'match_client']) {
      expect((await call<{ status: string }>(maya, tool, { documentId: id })).data.status, tool).toBe('denied');
      expect(await newest(db), tool).toMatchObject({ tool, outcome: 'denied', detail: 'still processing' });
    }
    await maya.close();
    expect((await getDocument(nb(db), id))?.extraction).toBeNull();

    await createWorker({ db, services, config: JOBS }).runUntilIdle();
    expect(await getJob(nb(db), jobId!)).toMatchObject({ status: 'done', step: 'filed' });
    await web.close();
    await db.close();
  }, 60_000);

  it('keeps its result when a slower extraction, started earlier, finishes after it was filed', async () => {
    const db = await demoDb();
    let finish = () => {};
    const slow: Extractor = {
      name: 'slow',
      extract: async () => {
        await new Promise<void>((resolve) => (finish = resolve));
        return { docType: 'other', docTypeConfidence: 0.2, clientName: null, taxYear: null, fields: [], model: 'slow' };
      },
    };
    const services = testServices();
    const { id } = await inboxDoc(db, services, ACME);
    const tom = await connectAs(db, TOM, { ...services, extractor: slow });
    const viewing = call(tom, 'extract_document', { documentId: id });
    await new Promise((r) => setTimeout(r, 300));
    const maya = await connectAs(db, MAYA, services);
    expect(
      (await call<{ status: string }>(maya, 'file_document', { documentId: id, clientId: 'cl_acme' })).data.status,
    ).toBe('filed');
    finish();
    await viewing;
    expect((await getDocument(nb(db), id))?.extraction).toMatchObject({ docType: 'invoice' });
    await Promise.all([tom.close(), maya.close()]);
    await db.close();
  }, 60_000);
});

describe('a document whose text was never read', () => {
  it('is withheld from assistants until its owner is known', async () => {
    const inner = memoryFileStore();
    let broken = true;
    const services = testServices({
      files: {
        put: (k, b, t) => inner.put(k, b, t),
        get: async (k) => {
          if (broken) throw new Error('S3 download failed (503): host s3.example');
          return inner.get(k);
        },
      },
    });
    const db = await demoDb();
    const web = await serve(db, services);
    const tom = await connectAs(db, TOM, services);
    const { id, jobId } = await batchDoc(db, services, MARLOW); // Marlow is Ana's client, not Tom's
    await createWorker({ db, services, config: JOBS }).runUntilIdle();
    expect(await getJob(nb(db), jobId!)).toMatchObject({ status: 'dead', step: 'stored' });
    // Only the kind of error is kept: partners and the public demo can read it.
    expect((await getJob(nb(db), jobId!))?.lastError).toBe('S3 download failed (503)');

    // Storage still down: nothing can be read, so nothing is shown.
    expect((await web.api(`/api/documents/${id}/file`, TOM)).status).toBeGreaterThanOrEqual(403);
    expect((await tom.callTool({ name: 'extract_document', arguments: { documentId: id } })).isError).toBe(true);
    broken = false;
    // Storage back: opening it reads it first, and it turns out to belong to another team.
    expect((await web.api(`/api/documents/${id}/file`, TOM)).status).toBe(403);
    expect((await call<{ status: string }>(tom, 'extract_document', { documentId: id })).data.status).toBe('denied');
    expect((await web.api(`/api/documents/${id}/file`, ANA)).status).toBe(200);

    // And the retry still files it: nobody cached an extraction of empty text.
    expect((await web.api(`/api/jobs/${jobId}/retry`, MAYA, { method: 'POST' })).status).toBe(200);
    await createWorker({ db, services, config: JOBS }).runUntilIdle();
    expect(await getDocument(nb(db), id)).toMatchObject({ status: 'filed', clientId: 'cl_marlow' });
    await tom.close();
    await web.close();
    await db.close();
  }, 60_000);
});

describe('model calls nobody should be able to cause', () => {
  it('the demo visitor and partners open a file without one; ten assistants at once cause one', async () => {
    const { extractor, state } = counting();
    const services = testServices({ extractor });
    const db = await demoDb();
    const web = await serve(db, services);
    const { id } = await inboxDoc(db, services, ACME);
    for (const user of [DEMO, DEMO, MAYA]) expect((await web.api(`/api/documents/${id}/file`, user)).status).toBe(200);
    expect(state.calls).toBe(0);
    expect(await getDocument(nb(db), id)).toMatchObject({ extraction: null, match: null });
    const views = await Promise.all(Array.from({ length: 10 }, () => web.api(`/api/documents/${id}/file`, TOM)));
    expect(new Set(views.map((v) => v.status))).toEqual(new Set([200]));
    expect(state.calls).toBe(1);
    await web.close();

    const demo = await connectAs(db, DEMO, services);
    const other = await inboxDoc(db, services, MARLOW);
    for (const tool of ['extract_document', 'match_client']) {
      expect((await call<{ status: string }>(demo, tool, { documentId: other.id })).data.status, tool).toBe('denied');
      expect(await newest(db), tool).toMatchObject({ staff_id: 'st_demo', tool, outcome: 'denied' });
    }
    expect(state.calls).toBe(1);
    await demo.close();
    await db.close();
  }, 60_000);

  it('the demo visitor is rate-limited, so the public can’t fill the audit log', async () => {
    const services = testServices();
    const db = await demoDb();
    const web = await serve(db, services);
    const statuses = [];
    for (let i = 0; i < 40; i++) statuses.push((await web.api('/api/batches', DEMO, { method: 'POST' })).status);
    expect(statuses.filter((s) => s === 403)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
    const [row] = await db.query<{ n: number }>(`select count(*)::int as n from audit_log where staff_id = 'st_demo'`);
    expect(row?.n).toBe(20);
    expect((await web.api('/api/inbox', MAYA)).status).toBe(200); // staff are not limited
    await web.close();
    await db.close();
  }, 60_000);

  it('counts an IPv6 visitor by their network, not one address', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe(clientKey('2001:0db8:1:2:bbbb:0:0:9'));
    expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
    expect(clientKey(undefined)).toBe('unknown');
  });
});

describe('hostile files', () => {
  it('a huge run of digits or blanks doesn’t freeze the server', async () => {
    const services = testServices();
    const db = await demoDb();
    const { id } = await inboxDoc(db, services, `${ACME}\n${'1'.repeat(100_000)}`);
    const maya = await connectAs(db, MAYA, services);
    let started = performance.now();
    const { data } = await call<{ status: string }>(maya, 'file_document', { documentId: id, clientId: 'cl_acme' });
    expect(data.status).toBe('filed');
    expect(performance.now() - started).toBeLessThan(3000); // was 22 s

    for (const filler of [' '.repeat(40_000), '\n'.repeat(40_000), 'a '.repeat(40_000), '1,'.repeat(40_000)]) {
      started = performance.now();
      await rulesExtractor().extract({ filename: null, pages: [`${ACME}\n${filler}`], textLayer: true, pdf: null });
      expect(performance.now() - started).toBeLessThan(1500);
    }
    expect(Math.max(...chunkPages(['x'.repeat(100_000)]).map((c) => c.content.length))).toBeLessThanOrEqual(2100);
    await maya.close();
    await db.close();
  }, 60_000);

  it('a document too large to read is refused, and in a batch not retried', async () => {
    expect(() => extractPlainText(new TextEncoder().encode('x'.repeat(500_001)))).toThrow(/more than 500000/);
    expect(() => extractPlainText(new TextEncoder().encode('a\f'.repeat(301)))).toThrow(/more than 300 pages/);
    const services = testServices();
    const db = await demoDb();
    const { jobId } = await batchDoc(db, services, 'x'.repeat(500_001));
    expect(await createWorker({ db, services, config: JOBS }).runUntilIdle()).toBe(1);
    expect(await getJob(nb(db), jobId!)).toMatchObject({ status: 'dead', attempts: 1 });
    await db.close();
  }, 60_000);
});

describe('filing that survives a failing embedding service', () => {
  it('resolving a review files, notes and audits; the passages are repaired later', async () => {
    let down = false;
    const local = localEmbedder();
    const services = testServices({
      embedder: {
        model: local.model,
        embed: async (t, k) => {
          if (down) throw new Error('Voyage embeddings failed (503)');
          return local.embed(t, k);
        },
      },
    });
    const db = await demoDb();
    const web = await serve(db, services);
    const { id } = await inboxDoc(db, services, ACME);
    await db.query(
      `update documents set status = 'review', review_reason = 'x', sent_to_review_at = now() where id = $1`,
      [id],
    );
    down = true;
    const res = await web.api(`/api/review/${id}/resolve`, MAYA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'cl_acme' }),
    });
    expect(res.status).toBe(200);
    expect(await getDocument(nb(db), id)).toMatchObject({ status: 'filed', clientId: 'cl_acme' });
    expect(await newest(db)).toMatchObject({ tool: 'dashboard:resolve_review', outcome: 'ok' });
    expect(await db.query(`select 1 from notes where kind = 'filing'`)).toHaveLength(1);
    const passage = async () =>
      (await db.query<{ content: string }>('select content from document_chunks where document_id = $1', [id]))[0]
        ?.content;
    expect(await passage()).toContain('unfiled'); // old passages stay until they can be rebuilt; never none

    expect(await reindexStale(nb(db), services.embedder)).toBe(0); // still down: logged, start-up carries on
    down = false;
    expect(await reindexStale(nb(db), services.embedder)).toBe(1);
    expect(await passage()).toContain('Acme Ltd |');
    expect(await reindexStale(nb(db), services.embedder)).toBe(0);
    await web.close();
    await db.close();
  }, 60_000);

  it('a document left without passages is rebuilt, and two rebuilds at once don’t collide', async () => {
    const services = testServices();
    const db = await demoDb();
    const { id } = await inboxDoc(db, services, ACME);
    await db.query('delete from document_chunks where document_id = $1', [id]);
    await db.query('update documents set indexed_version = null where id = $1', [id]);
    expect(await reindexStale(nb(db), services.embedder)).toBe(1);
    await Promise.all([reindexDocument(nb(db), services.embedder, id), reindexDocument(nb(db), services.embedder, id)]);
    expect(await db.query('select 1 from document_chunks where document_id = $1', [id])).toHaveLength(1);
    await db.close();
  }, 60_000);
});

describe('job claims', () => {
  it('are fenced per claim, even between two loops of the same worker', async () => {
    const services = testServices();
    const db = await demoDb();
    await batchDoc(db, services, ACME);
    const first = (await claimNext(db, 'same-worker', JOBS))!;
    await db.query(`update jobs set locked_at = now() - interval '1 hour'`);
    const second = (await claimNext(db, 'same-worker', JOBS))!;
    expect(second.lock).not.toBe(first.lock);
    expect(await advance(db, first, 'text_extracted', false)).toBe(false);
    expect(await advance(db, second, 'text_extracted', false)).toBe(true);
    await db.close();
  }, 60_000);

  it('an idle worker stops asking the database, and wakes at once when a job is queued', async () => {
    const services = testServices();
    const db = await demoDb();
    let claims = 0;
    const watched: Db = {
      ...db,
      query: (sql, params) => {
        if (sql.includes('skip locked')) claims++;
        return db.query(sql, params);
      },
    };
    const worker = createWorker({ db: watched, services, config: JOBS });
    worker.start();
    await new Promise((r) => setTimeout(r, 1500));
    expect(claims).toBe(1);
    const { jobId } = await batchDoc(db, services, ACME);
    worker.wake();
    for (let i = 0; i < 100 && (await getJob(nb(db), jobId!))?.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await getJob(nb(db), jobId!)).toMatchObject({ status: 'done' });
    await worker.stop();
    await db.close();
  }, 60_000);
});

describe('batch and API limits', () => {
  let db: Db;
  let services: AppServices;
  let web: Awaited<ReturnType<typeof serve>>;
  let tom: Client;

  beforeAll(async () => {
    services = testServices();
    db = await demoDbWithDocuments(services);
    web = await serve(db, services);
    tom = await connectAs(db, TOM, services);
  });
  afterAll(async () => {
    await tom.close();
    await web.close();
    await db.close();
  });
  const file = (text: string, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-filename': 'f.txt', ...headers },
    body: text,
  });

  it('a batch takes no more files than it was created for, even in parallel', async () => {
    const id = await createBatch(nb(db), 'st_maya', 1);
    const res = await Promise.all(
      Array.from({ length: 8 }, (_, i) => web.api(`/api/batches/${id}/files`, MAYA, file(`${ACME}\nCopy ${i}`))),
    );
    expect(res.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    expect(await db.query('select 1 from jobs where batch_id = $1', [id])).toHaveLength(1);
  });

  it('the same key at the same moment gives one job, whatever the bytes', async () => {
    const id = await createBatch(nb(db), 'st_maya', 5);
    const send = (text: string) =>
      web.api(`/api/batches/${id}/files`, MAYA, file(text, { 'idempotency-key': 'key-parallel-1' }));
    const res = await Promise.all([send(`${ACME}\nOne`), send(`${ACME}\nOne`), send(`${ACME}\nTwo`)]);
    const bodies = (await Promise.all(res.map((r) => r.json()))) as { jobId: number }[];
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(bodies.map((b) => b.jobId)).size).toBe(1);
    const orphans = `select 1 from documents d where d.status = 'processing' and not exists (select 1 from jobs j where j.document_id = d.id)`;
    expect(await db.query(orphans)).toEqual([]);
  });

  it('assistants and the demo visitor are refused every batch route, with an audit row', async () => {
    const id = await createBatch(nb(db), 'st_maya', 1);
    for (const [path, init, tool] of [
      [`/api/batches/${id}/files`, file('x'), 'dashboard:batch_upload'],
      [`/api/batches/${id}`, {}, 'dashboard:view_batch'],
      ['/api/jobs/1/retry', { method: 'POST' }, 'dashboard:retry_job'],
    ] as const) {
      expect((await web.api(path, TOM, init)).status, path).toBe(403);
      expect(await newest(db), path).toMatchObject({ staff_id: 'st_tom', tool, outcome: 'denied' });
    }
    for (const [path, init, tool] of [
      [`/api/batches/${id}/files`, file('x'), 'dashboard:batch_upload'],
      ['/api/jobs/1/retry', { method: 'POST' }, 'dashboard:retry_job'],
    ] as const) {
      expect((await web.api(path, DEMO, init)).status, path).toBe(403);
      expect(await newest(db), path).toMatchObject({ staff_id: 'st_demo', tool, outcome: 'denied' });
    }
  });

  it('another firm’s batch, job and open item ids are unknown ids, audited, and noted for the owner', async () => {
    const id = await createBatch(nb(db), 'st_maya', 1);
    for (const [path, init, tool] of [
      [`/api/batches/${id}`, {}, 'dashboard:view_batch'],
      [`/api/batches/${id}/files`, file('x'), 'dashboard:batch_upload'],
    ] as const) {
      expect((await web.api(path, LENA, init)).status, path).toBe(404);
      expect(await newest(db, HL), path).toMatchObject({ tool, outcome: 'denied', detail: 'unknown id' });
      // A made-up id leaves the same trace.
      await web.api(path.replace(id, 'bat_madeup'), LENA, init);
      expect(await newest(db, HL), path).toMatchObject({ tool, outcome: 'denied', detail: 'unknown id' });
    }
    const [item] = await db.query<{ id: string }>(`select id from open_items where firm_id = $1 limit 1`, [HL]);
    const filed = await call<{ status: string; openItemClosed: unknown }>(tom, 'file_document', {
      documentId: 'doc_inbox_northwind',
      clientId: 'cl_acme',
      openItemId: item!.id,
    });
    expect(filed.data).toMatchObject({ status: 'filed', openItemClosed: null });
    const rows = await db.query<{ tool: string; outcome: string }>(
      `select tool, outcome from audit_log where tool like 'file_document%' order by id desc limit 2`,
    );
    expect(rows).toContainEqual({ tool: 'file_document:open_item', outcome: 'denied' });
    const events = await db.query<{ kind: string }>('select distinct kind from security_events order by kind');
    expect(events.map((e) => e.kind)).toEqual(['batch', 'open_item']);
  });

  it('a client is named back only when its exact name or id was typed', async () => {
    const ask = async (client: string) =>
      (await call<{ status: string; message: string }>(tom, 'get_client', { client })).data;
    expect(await ask('Lakeside Dental Group')).toMatchObject({ status: 'denied' });
    expect((await ask('cl_marlow')).message).not.toMatch(/Marlow Studio/); // the id was typed, not the name
    // The caller's own log can't tell a fragment of a hidden name from nonsense.
    await ask('arlow');
    const hidden = await newest(db);
    await ask('zzzz');
    expect(hidden?.outcome).toBe((await newest(db))?.outcome);
    for (const fragment of ['st', 'arlow', 'm%w', 'Lakesid_', '%']) {
      const { status, message } = await ask(fragment);
      expect(status, fragment).not.toBe('denied');
      expect(message, fragment).not.toMatch(/Marlow|Lakeside Dental|Okoro|Brightline/);
    }
  });

  it('a duplicate upload doesn’t reveal the title of a document the uploader can’t see', async () => {
    const { id } = await inboxDoc(db, services, MARLOW, 'secret.txt');
    await db.query(
      `update documents set status = 'filed', client_id = 'cl_marlow', title = 'Marlow secret title' where id = $1`,
      [id],
    );
    const res = (await (await web.api('/api/documents', TOM, file(MARLOW))).json()) as {
      title: string;
      duplicate: boolean;
    };
    expect(res).toMatchObject({ duplicate: true, title: 'f.txt' });
  });

  it('odd numbers and ids in a URL are answered, not crashed on', async () => {
    for (const path of [
      '/api/usage?days=1.5',
      '/api/audit?limit=1.5',
      '/api/audit?before=1.5',
      '/api/audit?before=x',
    ]) {
      expect((await web.api(path, MAYA)).status, path).toBe(200);
    }
    expect((await web.api('/api/jobs/99999999999999999999/retry', MAYA, { method: 'POST' })).status).toBe(404);
    expect((await web.api('/api/documents/%00/file', MAYA)).status).toBe(404);
  });
});

describe('the database itself', () => {
  it('has row-level security on every firm-owned table and on everything the app role can touch', async () => {
    const db = await demoDb();
    const tables = await db.query<{ name: string; rls: boolean; firm: boolean; granted: boolean }>(
      `select c.relname as name, c.relrowsecurity as rls,
              exists (select 1 from information_schema.columns k where k.table_name = c.relname and k.column_name = 'firm_id') as firm,
              has_table_privilege('clientdesk_app', c.oid, 'select, insert, update, delete') as granted
       from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(tables.length).toBeGreaterThan(12);
    for (const t of tables) if (t.firm || t.granted) expect(t.rls, t.name).toBe(true);
    // A table added later is closed to the app until a migration opens it.
    await db.exec('create table later (id int)');
    await expect(nb(db).query('select * from later')).rejects.toThrow(/permission denied/);
    await db.close();
  }, 60_000);

  it('refuses references to another firm’s rows', async () => {
    const services = testServices();
    const db = await demoDb();
    const hl = db.forFirm(HL);
    const { id } = await inboxDoc(db, services, ACME);
    const batch = await createBatch(nb(db), 'st_maya', 1);
    for (const sql of [
      `insert into batches (id, created_by, total) values ('bat_x', 'st_maya', 1)`,
      `insert into audit_log (staff_id, tool, outcome) values ('st_maya', 'x', 'ok')`,
      `insert into llm_calls (staff_id, source, operation, provider, model, latency_ms, success) values ('st_maya', 'mcp', 'embed', 'p', 'm', 1, true)`,
      `insert into llm_calls (document_id, source, operation, provider, model, latency_ms, success) values ('${id}', 'mcp', 'embed', 'p', 'm', 1, true)`,
    ]) {
      await expect(hl.query(sql), sql).rejects.toThrow(/foreign key/);
    }
    const own = await ingestDocument(hl, services, {
      bytes: new TextEncoder().encode(ACME),
      mimeType: 'text/plain',
      filename: 'x.txt',
      uploadedBy: 'st_hl_lena',
    });
    await expect(
      hl.query(`insert into jobs (kind, batch_id, document_id, created_by) values ('intake', $1, $2, 'st_hl_lena')`, [
        batch,
        own.id,
      ]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      hl.query(`update documents set sent_to_review_by = 'st_maya' where id = $1`, [own.id]),
    ).rejects.toThrow(/foreign key/);
    await db.close();
  }, 60_000);
});
