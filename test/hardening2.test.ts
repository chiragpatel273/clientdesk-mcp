import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localEmbedder } from '../src/ai/embeddings.js';
import type { Extractor } from '../src/ai/extraction.js';
import { rulesExtractor } from '../src/ai/rules-extractor.js';
import { loadConfig, type JobsConfig } from '../src/config.js';
import type { Db } from '../src/db/index.js';
import { extractPdfText } from '../src/documents/text.js';
import { findClients } from '../src/domain/clients.js';
import {
  getDocument,
  ingestDocument,
  passageContext,
  reindexDocument,
  type DocumentRecord,
} from '../src/domain/documents.js';
import { findActorByEmail } from '../src/domain/staff.js';
import { createHttpApp } from '../src/http.js';
import { claimNext, createBatch, getJob } from '../src/jobs/queue.js';
import { createWorker } from '../src/jobs/worker.js';
import type { AppServices } from '../src/services.js';
import { memoryFileStore } from '../src/storage/files.js';
import { ANA, call, connectAs, demoDb, MAYA, nb, testServices, TOM } from './helpers.js';

/** Regression tests for the second review (2026-11-24): what the first round of fixes got wrong or missed. */

const JOBS: JobsConfig = { worker: false, concurrency: 1, maxAttempts: 3, backoffMs: 0, stuckSeconds: 60 };
const MARLOW =
  'TAX INVOICE\nFrom: Paper Co\nInvoice number: MS-1\nInvoice date: 2026-04-02\nBill to: Marlow Studio LLC\nTotal due: $3.00';
const ACME = MARLOW.replace('Marlow Studio LLC', 'Acme Ltd').replace('MS-1', 'AC-1');

async function serve(db: Db, services: AppServices, onJobQueued?: () => void) {
  const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev' });
  const app = createHttpApp({ db, config, services, projectRoot: '/nonexistent', onJobQueued });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    api: (path: string, user: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { 'x-clientdesk-user': user, 'x-clientdesk-csrf': '1', ...(init.headers as Record<string, string>) },
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
const store = (db: Db, services: AppServices, text: string, batch = false) =>
  ingestDocument(nb(db), services, {
    bytes: new TextEncoder().encode(text),
    mimeType: 'text/plain',
    filename: 'f.txt',
    uploadedBy: 'st_maya',
    ...(batch ? { intakeJob: { createdBy: 'st_maya', batchId: null, idempotencyKey: null, maxAttempts: 3 } } : {}),
  });
const audits = (db: Db, tool: string) =>
  db.query<{ outcome: string; staff_id: string }>(
    'select outcome, staff_id from audit_log where tool = $1 order by id',
    [tool],
  );
const file = (text: string, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'text/plain', 'x-filename': 'f.txt', ...headers },
  body: text,
});

describe('hostile files, again', () => {
  it('a PDF page with tens of thousands of lines is read in seconds', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([600, 4 * 40_000]);
    for (let i = 0; i < 40_000; i++) page.drawText('abc', { x: 10, y: 4 * i, size: 3, font });
    const bytes = await pdf.save();
    const started = performance.now();
    const { pages } = await extractPdfText(bytes);
    expect(performance.now() - started).toBeLessThan(6000); // was 22 s
    expect(pages[0]!.split('\n')).toHaveLength(40_000);
  }, 120_000);

  it('an unclosed bracket after a label is not searched for through the whole file', async () => {
    for (const label of ['tax (', 'sales tax (', 'vat (']) {
      const started = performance.now();
      const pages = [`TAX INVOICE\n${`${label}\n`.repeat(40_000)}`];
      await rulesExtractor().extract({ filename: null, pages, textLayer: true, pdf: null });
      expect(performance.now() - started, label).toBeLessThan(1500);
    }
  }, 120_000);

  it('still recognises amounts as they are written', () => {
    const doc = {
      title: 't',
      clientName: 'c',
      extraction: {
        docType: 'bank_statement',
        fields: [{ name: 'closing_balance', value: '90677.03', confidence: 1 }],
      },
    } as unknown as DocumentRecord;
    for (const text of ['Closing: $90,677.03', 'Closing balance,90677.03', 'x,Closing,90677.03', '90,677.03']) {
      expect(passageContext(doc, text, 1), text).toContain('balance at the end of the period');
    }
    expect(passageContext(doc, '190677.03 and 1,90677.034', 1)).not.toContain('balance at the end');
  });
});

describe('opening a document nobody has read yet', () => {
  function flaky() {
    const inner = memoryFileStore();
    const state = { broken: true };
    const files = {
      put: inner.put.bind(inner),
      get: async (k: string) => {
        if (state.broken) throw new Error('S3 download failed (503)');
        return inner.get(k);
      },
    };
    return { files, state };
  }

  it('shows it to the assistant whose client it is, the first time', async () => {
    const { files, state } = flaky();
    const services = testServices({ files });
    const db = await demoDb();
    const web = await serve(db, services);
    const { id } = await store(db, services, MARLOW, true);
    await createWorker({ db, services, config: JOBS }).runUntilIdle();
    state.broken = false;
    expect((await web.api(`/api/documents/${id}/file`, ANA)).status).toBe(200); // Marlow is Ana's client
    await web.close();
    await db.close();
  }, 60_000);

  it('is refused with a 503 and an audit row while storage or the model is failing', async () => {
    const { files } = flaky();
    const services = testServices({ files });
    const db = await demoDb();
    const web = await serve(db, services);
    const { id } = await store(db, services, MARLOW, true);
    await createWorker({ db, services, config: JOBS }).runUntilIdle();
    expect((await web.api(`/api/documents/${id}/file`, TOM)).status).toBe(503);
    expect(await audits(db, 'dashboard:view_document')).toEqual([{ outcome: 'error', staff_id: 'st_tom' }]);
    const link = new URL(services.links.url(id, 'st_tom'));
    expect((await fetch(`${web.base}${link.pathname}${link.search}`)).status).toBe(503);
    expect(await audits(db, 'download_document')).toEqual([{ outcome: 'error', staff_id: 'st_tom' }]);
    await web.close();
    await db.close();
  }, 60_000);

  it('a model provider’s 404 is an error, not "not found"', async () => {
    const notFound: Extractor = {
      name: 'x',
      extract: () => Promise.reject(Object.assign(new Error('model does not exist'), { status: 404 })),
    };
    const services = testServices({ extractor: notFound });
    const db = await demoDb();
    const web = await serve(db, services);
    const { id } = await store(db, services, ACME);
    expect((await web.api(`/api/documents/${id}/file`, TOM)).status).toBe(503);
    expect(await audits(db, 'dashboard:view_document')).toEqual([{ outcome: 'error', staff_id: 'st_tom' }]);
    await web.close();
    await db.close();
  }, 60_000);

  it('an extraction that finishes after the document was filed elsewhere shows nothing', async () => {
    let finish = () => {};
    const slow: Extractor = {
      name: 'slow',
      extract: async () => {
        await new Promise<void>((resolve) => (finish = resolve));
        return { docType: 'other', docTypeConfidence: 0.2, clientName: null, taxYear: null, fields: [], model: 'slow' };
      },
    };
    const services = testServices();
    const db = await demoDb();
    const { id } = await store(db, services, 'Some letter with no client named in it at all.');
    const tom = await connectAs(db, TOM, { ...services, extractor: slow });
    const pending = call<{ status: string }>(tom, 'extract_document', { documentId: id });
    await new Promise((r) => setTimeout(r, 300));
    await db.query(`update documents set status = 'filed', client_id = 'cl_marlow' where id = $1`, [id]);
    finish();
    expect((await pending).data.status).toBe('denied');
    await tom.close();
    await db.close();
  }, 60_000);
});

describe('the worker', () => {
  it('doesn’t miss a job queued while it was deciding to sleep', async () => {
    const services = testServices();
    const db = await demoDb();
    const handle: { worker?: ReturnType<typeof createWorker>; jobId?: number; done?: boolean } = {};
    const watched: Db = {
      ...db,
      query: async (sql, params) => {
        const rows = await db.query(sql, params);
        // The job arrives (and wakes the worker) after its last look and before it sleeps.
        if (sql.includes('locked_at + make_interval') && !handle.done) {
          handle.done = true;
          handle.jobId = (await store(db, services, ACME, true)).jobId!;
          handle.worker!.wake();
        }
        return rows as never;
      },
    };
    handle.worker = createWorker({ db: watched, services, config: JOBS });
    handle.worker.start();
    for (let i = 0; i < 100 && (!handle.jobId || (await getJob(nb(db), handle.jobId))?.status !== 'done'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await getJob(nb(db), handle.jobId!)).toMatchObject({ status: 'done' });
    await handle.worker.stop();
    await db.close();
  }, 60_000);

  it('is woken by someone watching a batch that still has work (queued by another server, say)', async () => {
    const services = testServices();
    const db = await demoDb();
    let wakes = 0;
    const web = await serve(db, services, () => wakes++);
    const id = await createBatch(nb(db), 'st_maya', 1);
    await ingestDocument(nb(db), services, {
      bytes: new TextEncoder().encode(ACME),
      mimeType: 'text/plain',
      filename: 'f.txt',
      uploadedBy: 'st_maya',
      intakeJob: { createdBy: 'st_maya', batchId: id, idempotencyKey: null, maxAttempts: 3 },
    });
    await web.api(`/api/batches/${id}`, MAYA);
    expect(wakes).toBe(1);
    await createWorker({ db, services, config: JOBS }).runUntilIdle();
    await web.api(`/api/batches/${id}`, MAYA);
    expect(wakes).toBe(1); // settled: nothing to wake for
    await web.close();
    await db.close();
  }, 60_000);

  it('finishes a filed document’s last step even if the uploader lost their role meanwhile', async () => {
    const services = testServices();
    const db = await demoDb();
    const { id, jobId } = await store(db, services, ACME, true);
    const worker = createWorker({ db, services, config: JOBS });
    while ((await getJob(nb(db), jobId!))?.step !== 'filed') await worker.tick();
    await db.query(`update staff set role = 'assistant' where id = 'st_maya'`);
    await worker.runUntilIdle();
    expect(await getJob(nb(db), jobId!)).toMatchObject({ status: 'done', step: 'filed' });
    const [chunk] = await db.query<{ content: string }>('select content from document_chunks where document_id = $1', [
      id,
    ]);
    expect(chunk?.content).toContain('Acme Ltd |');
    expect(await claimNext(db, 'w', JOBS)).toBeNull();
    await db.close();
  }, 60_000);
});

describe('search passages', () => {
  it('a rebuild that started from an older version doesn’t overwrite a newer one', async () => {
    const services = testServices();
    const db = await demoDb();
    const { id } = await store(db, services, ACME);
    const local = localEmbedder();
    let release = () => {};
    const slow = {
      model: local.model,
      embed: async (t: string[], k: 'document' | 'query') => {
        await new Promise<void>((r) => (release = r));
        return local.embed(t, k);
      },
    };
    const old = reindexDocument(nb(db), slow, id);
    await new Promise((r) => setTimeout(r, 200));
    await db.query(`update documents set title = 'Newer title', content_version = content_version + 1 where id = $1`, [
      id,
    ]);
    await reindexDocument(nb(db), local, id);
    release();
    await old;
    const [chunk] = await db.query<{ content: string }>('select content from document_chunks where document_id = $1', [
      id,
    ]);
    expect(chunk?.content).toContain('Newer title');
    const [doc] = await db.query('select content_version, indexed_version from documents where id = $1', [id]);
    expect(doc).toEqual({ content_version: 2, indexed_version: 2 });
    await db.close();
  }, 60_000);

  it('a single upload works while embeddings are down: it is in the inbox, not "could not read that file"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const services = testServices({ embedder: { model: 'down', embed: () => Promise.reject(new Error('down')) } });
    const db = await demoDb();
    const web = await serve(db, services);
    const res = await web.api('/api/documents', TOM, file(ACME));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: false });
    await web.close();
    await db.close();
    vi.restoreAllMocks();
  }, 60_000);
});

describe('batches', () => {
  it('a full batch stores nothing, and the same key on its last place gives the same job to everyone', async () => {
    const inner = memoryFileStore();
    let puts = 0;
    const services = testServices({
      files: { put: (k, b, t) => (puts++, inner.put(k, b, t)), get: inner.get.bind(inner) },
    });
    const db = await demoDb();
    const web = await serve(db, services);
    const id = await createBatch(nb(db), 'st_maya', 1);
    const send = (text: string, key: string) =>
      web.api(`/api/batches/${id}/files`, MAYA, file(text, { 'idempotency-key': key }));
    const res = await Promise.all([send(`${ACME}\nOne`, 'same-key-1'), send(`${ACME}\nTwo`, 'same-key-1')]);
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    const bodies = (await Promise.all(res.map((r) => r.json()))) as { jobId: number }[];
    expect(bodies[0]!.jobId).toBe(bodies[1]!.jobId);

    puts = 0;
    for (let i = 0; i < 3; i++) expect((await send(`${ACME}\nFull ${i}`, `other-key-${i}`)).status).toBe(409);
    expect(puts).toBe(0);
    expect((await audits(db, 'dashboard:batch_upload')).filter((a) => a.outcome === 'error')).toHaveLength(3);
    await web.close();
    await db.close();
  }, 60_000);
});

describe('filing through Claude', () => {
  it('is audited as filed even if something after it fails', async () => {
    const services = testServices();
    const db = await demoDb();
    const { id } = await store(db, services, ACME);
    await db.exec(`create function boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
                   create trigger t before update on open_items for each row execute function boom()`);
    const maya = await connectAs(db, MAYA, services);
    const [item] = await db.query<{ id: string }>(
      `select id from open_items where client_id = 'cl_acme' and status = 'open' limit 1`,
    );
    const { data } = await call<{ status: string; openItemClosed: unknown }>(maya, 'file_document', {
      documentId: id,
      clientId: 'cl_acme',
      openItemId: item!.id,
    });
    expect(data).toMatchObject({ status: 'filed', openItemClosed: null });
    expect((await getDocument(nb(db), id))?.status).toBe('filed');
    expect(await audits(db, 'file_document')).toEqual([{ outcome: 'ok', staff_id: 'st_maya' }]);
    await maya.close();
    await db.close();
  }, 60_000);

  it('finds an assistant’s own client even when many hidden ones match first', async () => {
    const db = await demoDb();
    for (let i = 0; i < 15; i++) {
      await nb(db).query(`insert into clients (id, name, entity_type) values ($1, $2, 'company')`, [
        `cl_x${i}`,
        `Aa kim ${i}`,
      ]);
    }
    const tom = (await findActorByEmail(db, TOM))!;
    expect((await findClients(nb(db), 'kim', tom)).map((c) => c.id)).toContain('cl_kim');
    await db.close();
  }, 60_000);
});
