import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { firmOf, type Db } from '../src/db/index.js';
import { renderTextPdf } from '../src/documents/pdf-render.js';
import { accessibleClientIds, canAccessClient } from '../src/domain/access.js';
import { getDocument, ingestDocument } from '../src/domain/documents.js';
import { ensureMatch } from '../src/domain/intake.js';
import { findActorByEmail } from '../src/domain/staff.js';
import { createHttpApp } from '../src/http.js';
import { createWorker } from '../src/jobs/worker.js';
import type { AppServices } from '../src/services.js';
import { call, connectAs, demoDbWithDocuments, HL, LENA, MAYA, NB, testServices, TOM } from './helpers.js';

/** The newest audit row a firm holds (the owner handle sees every firm; filter explicitly). */
const lastAuditOf = async (db: Db, firmId: string) =>
  (
    await db.query<{ staff_id: string; tool: string; outcome: string; detail: string | null }>(
      'select staff_id, tool, outcome, detail from audit_log where firm_id = $1 order by id desc limit 1',
      [firmId],
    )
  )[0];

describe('two firms in one database', () => {
  let db: Db;
  let services: AppServices;
  let tom: Client;
  let maya: Client;
  let lena: Client;

  beforeAll(async () => {
    services = testServices();
    db = await demoDbWithDocuments(services);
    tom = await connectAs(db, TOM, services);
    maya = await connectAs(db, MAYA, services);
    lena = await connectAs(db, LENA, services);
  });

  afterAll(async () => {
    await Promise.all([tom, maya, lena].map((c) => c.close()));
    await db.close();
  });

  describe('layer 2 on its own: row-level security, even for raw SQL without a firm filter', () => {
    it('shows a scoped handle only its own firm’s rows', async () => {
      const nbDocs = await db.forFirm(NB).query<{ id: string }>('select id from documents');
      const hlDocs = await db.forFirm(HL).query<{ id: string }>('select id from documents');
      expect(nbDocs.map((d) => d.id)).not.toContain('doc_hl_acme_invoice');
      expect(hlDocs.map((d) => d.id).sort()).toEqual(['doc_hl_acme_invoice', 'doc_hl_inbox_acme']);
      const chunks = await db
        .forFirm(NB)
        .query<{ n: number }>(`select count(*)::int as n from document_chunks where document_id like 'doc_hl_%'`);
      expect(chunks[0]?.n).toBe(0);
    });

    it('refuses writes into another firm and can’t touch its rows', async () => {
      await expect(
        db
          .forFirm(NB)
          .query(`insert into notes (id, client_id, body, firm_id) values ('nt_x', 'cl_hl_acme', 'x', $1)`, [HL]),
      ).rejects.toThrow(/row-level security/);
      const updated = await db
        .forFirm(NB)
        .query(`update documents set title = 'hijacked' where id = 'doc_hl_acme_invoice' returning id`);
      expect(updated).toEqual([]);
      const deleted = await db.forFirm(NB).query(`delete from clients where id = 'cl_hl_acme' returning id`);
      expect(deleted).toEqual([]);
    });

    it('fills firm_id from the scope, and refuses an insert made outside any firm', async () => {
      const [row] = await db
        .forFirm(HL)
        .query<{ firm_id: string }>(
          `insert into notes (id, client_id, body) values ('nt_scoped', 'cl_hl_acme', 'scoped') returning firm_id`,
        );
      expect(row?.firm_id).toBe(HL);
      await expect(
        db.query(`insert into notes (id, client_id, body) values ('nt_unscoped', 'cl_acme', 'no firm')`),
      ).rejects.toThrow(/null value in column "firm_id"/);
    });

    it('rejects a cross-firm reference in the schema itself, even on the owner connection', async () => {
      await expect(
        db.query(`update documents set client_id = 'cl_hl_acme' where id = 'doc_acme_laptops'`),
      ).rejects.toThrow(/foreign key/);
    });

    it('keeps the setting inside one query: a scoped handle never leaks its firm to the next query', async () => {
      await db.forFirm(HL).query('select 1');
      const [row] = await db.query<{ firm: string | null; role: string }>(
        `select nullif(current_setting('app.firm_id', true), '') as firm, current_user as role`,
      );
      expect(row).toEqual({ firm: null, role: 'postgres' });
    });
  });

  describe('layer 1 on its own: the domain layer', () => {
    it('refuses to read firm data through an unscoped handle (fails closed)', async () => {
      await expect(getDocument(db, 'doc_acme_laptops')).rejects.toThrow(/firm-scoped/);
      expect(() => firmOf(db)).toThrow();
      expect(() => db.forFirm(NB).forFirm(HL)).toThrow(/cannot switch firms/);
    });

    it('never grants access to a client of another firm, whatever the role', async () => {
      const lenaActor = (await findActorByEmail(db, LENA))!;
      const mayaActor = (await findActorByEmail(db, MAYA))!;
      expect(lenaActor.firmId).toBe(HL);
      // Even handed the wrong firm's handle (a bug), a partner of one firm can't reach the other's clients.
      expect(await canAccessClient(db.forFirm(NB), lenaActor, 'cl_acme')).toBe(false);
      expect(await accessibleClientIds(db.forFirm(NB), lenaActor)).toEqual([]);
      expect(await canAccessClient(db.forFirm(NB), mayaActor, 'cl_hl_acme')).toBe(false);
      expect(await canAccessClient(db.forFirm(NB), mayaActor, 'cl_acme')).toBe(true);
    });
  });

  describe('Claude (MCP tools)', () => {
    it('finds only its own firm’s "Acme Ltd" by name', async () => {
      const nbAcme = await call<{ status: string; client: { id: string } }>(maya, 'get_client', { client: 'Acme Ltd' });
      expect(nbAcme.data).toMatchObject({ status: 'found', client: { id: 'cl_acme' } });
      const hlAcme = await call<{ status: string; client: { id: string } }>(lena, 'get_client', { client: 'Acme Ltd' });
      expect(hlAcme.data).toMatchObject({ status: 'found', client: { id: 'cl_hl_acme' } });
    });

    it('answers a forged client id from another firm as "not found", and audits it as denied', async () => {
      const { data } = await call<{ status: string; message: string }>(maya, 'get_client', { client: 'cl_hl_acme' });
      expect(data.status).toBe('not_found');
      expect(data.message).not.toMatch(/Harbourline/);
      expect(await lastAuditOf(db, NB)).toMatchObject({
        staff_id: 'st_maya',
        tool: 'get_client',
        outcome: 'denied',
        detail: 'unknown id',
      });
      const real = await lastAuditOf(db, NB);
      // An id that exists nowhere leaves exactly the same trace: the firm's own log can't be used to find out which ids
      // exist elsewhere. Only the owner of the deployment sees the difference.
      await call(maya, 'get_client', { client: 'cl_nobody' });
      expect(await lastAuditOf(db, NB)).toEqual(real);
      const events = await db.query<{ object_id: string; owner_firm_id: string; staff_id: string }>(
        `select object_id, owner_firm_id, staff_id from security_events where tool = 'get_client'`,
      );
      expect(events).toEqual([{ object_id: 'cl_hl_acme', owner_firm_id: HL, staff_id: 'st_maya' }]);
      await expect(db.forFirm(NB).query('select * from security_events')).rejects.toThrow(/permission denied/);
    });

    it('never searches another firm’s documents', async () => {
      const { data } = await call<{ passages?: { documentId: string }[] }>(maya, 'search_documents', {
        query: 'Quayside Packaging invoice HB-5520 shipping cartons',
      });
      expect((data.passages ?? []).every((p) => !p.documentId.startsWith('doc_hl_'))).toBe(true);
      const hl = await call<{ passages?: { documentId: string }[] }>(lena, 'search_documents', {
        query: 'Quayside Packaging invoice HB-5520 shipping cartons',
      });
      expect(hl.data.passages?.[0]?.documentId).toBe('doc_hl_acme_invoice');
    });

    it('lists only its own inbox and refuses another firm’s document by id', async () => {
      const inbox = await call<{ documents: { id: string }[] }>(tom, 'list_inbox', {});
      expect(inbox.data.documents.map((d) => d.id)).not.toContain('doc_hl_inbox_acme');

      for (const [tool, args] of [
        ['extract_document', { documentId: 'doc_hl_inbox_acme' }],
        ['match_client', { documentId: 'doc_hl_inbox_acme' }],
        ['send_to_review', { documentId: 'doc_hl_inbox_acme', reason: 'forged id from another firm' }],
        ['file_document', { documentId: 'doc_hl_inbox_acme', clientId: 'cl_acme' }],
      ] as const) {
        const { data } = await call<{ status: string }>(maya, tool, args);
        expect(data.status, tool).toBe('not_found');
        expect(await lastAuditOf(db, NB), tool).toMatchObject({
          tool,
          outcome: 'denied',
          detail: 'unknown id',
        });
      }
      const [doc] = await db.query<{ status: string; client_id: string | null }>(
        `select status, client_id from documents where id = 'doc_hl_inbox_acme'`,
      );
      expect(doc).toEqual({ status: 'inbox', client_id: null });
    });

    it('refuses to file its own document to another firm’s client', async () => {
      const { data } = await call<{ status: string }>(maya, 'file_document', {
        documentId: 'doc_inbox_northwind',
        clientId: 'cl_hl_acme',
      });
      expect(data.status).toBe('denied');
      expect(await lastAuditOf(db, NB)).toMatchObject({ tool: 'file_document', outcome: 'denied' });
    });

    it('matches documents only against its own firm’s clients, even with the same client name', async () => {
      const nbDoc = (await getDocument(db.forFirm(NB), 'doc_inbox_northwind'))!;
      const nbMatch = (await ensureMatch(db.forFirm(NB), services, nbDoc, { role: 'assistant' }))!;
      expect(nbMatch.candidates.map((c) => c.clientId)).not.toContain('cl_hl_acme');
      expect(nbMatch.candidates[0]?.clientId).toBe('cl_acme');

      const hlDoc = (await getDocument(db.forFirm(HL), 'doc_hl_inbox_acme'))!;
      const hlMatch = (await ensureMatch(db.forFirm(HL), services, hlDoc, { role: 'assistant' }))!;
      expect(hlMatch.candidates.map((c) => c.clientId)).not.toContain('cl_acme');
      expect(hlMatch.candidates[0]?.clientId).toBe('cl_hl_acme');
    });

    it('keeps each firm’s audit log to itself', async () => {
      const crossed = await db.query<{ n: number }>(
        `select count(*)::int as n from audit_log a join staff s on s.id = a.staff_id where a.firm_id <> s.firm_id`,
      );
      expect(crossed[0]?.n).toBe(0);
    });
  });

  describe('dashboard API and signed links', () => {
    let server: Server;
    let base: string;

    beforeAll(async () => {
      const app = createHttpApp({
        db,
        config: loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev' }),
        services,
        projectRoot: '/nonexistent',
      });
      server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    const api = (path: string, user: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { 'x-clientdesk-user': user, 'x-clientdesk-csrf': '1', ...(init.headers as Record<string, string>) },
      });

    it('shows each firm only its own inbox, counts and audit log', async () => {
      const lenaInbox = (await (await api('/api/inbox', LENA)).json()) as { items: { id: string }[] };
      expect(lenaInbox.items.map((i) => i.id)).toEqual(['doc_hl_inbox_acme']);
      const lenaStats = (await (await api('/api/stats', LENA)).json()) as { documents: { filed: number } };
      expect(lenaStats.documents.filed).toBe(1);
      const mayaAudit = (await (await api('/api/audit?limit=200', MAYA)).json()) as {
        rows: { staff: { id: string } }[];
      };
      expect(mayaAudit.rows.every((r) => !r.staff.id.startsWith('st_hl_'))).toBe(true);
    });

    it('answers another firm’s document as not found, and audits the attempt', async () => {
      const res = await api('/api/documents/doc_acme_laptops/file', LENA);
      expect(res.status).toBe(404);
      expect(await lastAuditOf(db, HL)).toMatchObject({
        staff_id: 'st_hl_lena',
        tool: 'dashboard:view_document',
        outcome: 'denied',
        detail: 'unknown id',
      });
    });

    it('won’t resolve a review into another firm’s client', async () => {
      await db.query(
        `update documents set status = 'review', review_reason = 'test', sent_to_review_at = now() where id = 'doc_hl_inbox_acme'`,
      );
      const res = await api('/api/review/doc_hl_inbox_acme/resolve', LENA, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: 'cl_acme' }),
      });
      expect(res.status).toBe(400);
      expect(await lastAuditOf(db, HL)).toMatchObject({ tool: 'dashboard:resolve_review', outcome: 'denied' });
      await db.query(`update documents set status = 'inbox', review_reason = null where id = 'doc_hl_inbox_acme'`);
    });

    it('refuses a signed link for another firm’s document, even with a valid signature', async () => {
      // A valid signature (as if the link secret leaked) for Tom and a Harbourline document: still refused.
      const link = new URL(services.links.url('doc_hl_acme_invoice', 'st_tom'));
      const res = await fetch(`${base}${link.pathname}${link.search}`);
      expect(res.status).toBe(404);
      expect(await lastAuditOf(db, NB)).toMatchObject({
        staff_id: 'st_tom',
        tool: 'download_document',
        outcome: 'denied',
        detail: 'unknown id',
      });
      // Lena's own link works.
      const own = new URL(services.links.url('doc_hl_acme_invoice', 'st_hl_lena'));
      expect((await fetch(`${base}${own.pathname}${own.search}`)).status).toBe(200);
    });

    it('won’t retry another firm’s job', async () => {
      const { jobId } = await ingestDocument(db.forFirm(NB), services, {
        bytes: await renderTextPdf('j', ['INVOICE\nBill to: Acme Ltd\nTotal due: $3.00']),
        mimeType: 'application/pdf',
        filename: 'j.pdf',
        uploadedBy: 'st_maya',
        intakeJob: { createdBy: 'st_maya', batchId: null, idempotencyKey: null, maxAttempts: 1 },
      });
      await db.query(`update jobs set status = 'dead' where id = $1`, [jobId]);
      const res = await api(`/api/jobs/${jobId}/retry`, LENA, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(await lastAuditOf(db, HL)).toMatchObject({ tool: 'dashboard:retry_job', outcome: 'denied' });
    });
  });

  describe('background jobs and usage', () => {
    it('processes each firm’s batch inside that firm: files to its own client, records its own usage', async () => {
      const hlDb = db.forFirm(HL);
      const { id } = await ingestDocument(hlDb, services, {
        bytes: await renderTextPdf('hl', [
          'INVOICE\nInvoice number: HB-7000\nBill to: Acme Ltd\nAttention: Jonas Reed\nTotal due: $88.00',
        ]),
        mimeType: 'application/pdf',
        filename: 'hl.pdf',
        uploadedBy: 'st_hl_lena',
        intakeJob: { createdBy: 'st_hl_lena', batchId: null, idempotencyKey: null, maxAttempts: 3 },
      });
      await createWorker({ db, services, config: loadConfig({ NODE_ENV: 'test' }).jobs }).runUntilIdle();

      const [doc] = await db.query<{ status: string; client_id: string; firm_id: string }>(
        'select status, client_id, firm_id from documents where id = $1',
        [id],
      );
      expect(doc).toEqual({ status: 'filed', client_id: 'cl_hl_acme', firm_id: HL });
      const usage = await db.query<{ firm_id: string }>(
        'select distinct firm_id from llm_calls where document_id = $1',
        [id],
      );
      expect(usage).toEqual([{ firm_id: HL }]);
      const audits = await db.query<{ firm_id: string }>(
        `select distinct firm_id from audit_log where input->>'documentId' = $1`,
        [id],
      );
      expect(audits).toEqual([{ firm_id: HL }]);
    }, 60_000);

    it('detects duplicates per firm: the same file in two firms is two documents', async () => {
      const bytes = await renderTextPdf('same', ['The same bytes, uploaded by two different firms.']);
      const nbUpload = await ingestDocument(db.forFirm(NB), services, {
        bytes,
        mimeType: 'application/pdf',
        filename: 'same.pdf',
        uploadedBy: 'st_tom',
      });
      const hlUpload = await ingestDocument(db.forFirm(HL), services, {
        bytes,
        mimeType: 'application/pdf',
        filename: 'same.pdf',
        uploadedBy: 'st_hl_sam',
      });
      expect(nbUpload.duplicate).toBe(false);
      expect(hlUpload.duplicate).toBe(false); // not "already in ClientDesk": that would reveal the other firm's file
      expect(hlUpload.id).not.toBe(nbUpload.id);
    });
  });
});
