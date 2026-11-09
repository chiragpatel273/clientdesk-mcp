import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.js';
import { getDocument, ingestDocument } from '../src/domain/documents.js';
import type { AppServices } from '../src/services.js';
import { ANA, call, connectAs, demoDbWithDocuments, lastAudit, MAYA, testServices, TOM } from './helpers.js';

type Passage = { documentId: string; title: string; clientId: string; page: number | null; link: string };

describe('document tools', () => {
  let db: Db;
  let services: AppServices;
  let maya: Client;
  let tom: Client;
  let ana: Client;

  beforeAll(async () => {
    services = testServices();
    db = await demoDbWithDocuments(services);
    maya = await connectAs(db, MAYA, services);
    tom = await connectAs(db, TOM, services);
    ana = await connectAs(db, ANA, services);
  });

  afterAll(async () => {
    await Promise.all([maya.close(), tom.close(), ana.close()]);
    await db.close();
  });

  it('advertises honest annotations for every tool', async () => {
    const { tools } = await maya.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of [
      'get_client',
      'search_documents',
      'list_open_items',
      'list_inbox',
      'extract_document',
      'match_client',
    ]) {
      expect(byName[name]?.annotations?.readOnlyHint, name).toBe(true);
    }
    for (const name of ['file_document', 'add_crm_note', 'send_to_review']) {
      expect(byName[name]?.annotations?.readOnlyHint, name).toBe(false);
      expect(byName[name]?.annotations?.destructiveHint, name).toBeDefined();
    }
    expect(tools.every((t) => t.outputSchema)).toBe(true);
  });

  describe('ingestion', () => {
    it('chunks, embeds and stores every demo document', async () => {
      const [row] = await db.query<{ docs: number; chunks: number; missing: number }>(
        `select (select count(*)::int from documents) as docs, (select count(*)::int from document_chunks) as chunks,
                (select count(*)::int from document_chunks where embedding is null) as missing`,
      );
      expect(row).toMatchObject({ docs: 13, missing: 0 });
      expect(Number(row!.chunks)).toBeGreaterThanOrEqual(13);
    });

    it('returns the existing document when the same file is uploaded twice', async () => {
      const bytes = new TextEncoder().encode('Plain text note\nThis is a test upload with enough text.');
      const first = await ingestDocument(db, services, {
        bytes,
        mimeType: 'text/plain',
        filename: 'a.txt',
        uploadedBy: 'st_tom',
      });
      const second = await ingestDocument(db, services, {
        bytes,
        mimeType: 'text/plain',
        filename: 'b.txt',
        uploadedBy: 'st_tom',
      });
      expect(second).toEqual({ id: first.id, duplicate: true });
      await db.query('delete from documents where id = $1', [first.id]);
    });
  });

  describe('search_documents', () => {
    it('returns cited passages with signed links', async () => {
      const { data } = await call<{ status: string; passages: Passage[] }>(maya, 'search_documents', {
        query: 'Acme engagement letter annual fee',
      });
      expect(data.status).toBe('ok');
      const top = data.passages[0]!;
      expect(top.documentId).toBe('doc_acme_engagement_2026');
      expect(top.page).toBe(1);
      expect(top.link).toMatch(/^http:\/\/localhost:3000\/files\/doc_acme_engagement_2026\?u=st_maya&exp=\d+&sig=/);
    });

    it("never returns documents from clients the user isn't assigned to", async () => {
      const { data } = await call<{ passages: Passage[] }>(tom, 'search_documents', {
        query: 'DentalSoft practice management licence invoice',
        limit: 10,
      });
      expect(data.passages.some((p) => p.clientId === 'cl_lakeside')).toBe(false);
      const { data: forAna } = await call<{ passages: Passage[] }>(ana, 'search_documents', {
        query: 'DentalSoft practice management licence invoice',
      });
      expect(forAna.passages[0]?.clientId).toBe('cl_lakeside');
    });

    it('refuses a client filter for an unassigned client, and logs it', async () => {
      const { data } = await call<{ status: string }>(tom, 'search_documents', {
        query: 'invoice',
        client: 'Lakeside Dental Group',
      });
      expect(data.status).toBe('denied');
      expect(await lastAudit(db)).toMatchObject({ staff_id: 'st_tom', tool: 'search_documents', outcome: 'denied' });
    });

    it('asks which client when the filter is ambiguous', async () => {
      const { data } = await call<{ status: string; candidates: { id: string }[] }>(maya, 'search_documents', {
        query: 'invoice',
        client: 'Acme',
      });
      expect(data.status).toBe('ambiguous');
      expect(data.candidates.map((c) => c.id).sort()).toEqual(['cl_acme', 'cl_acme_labs']);
    });

    it('filters by tax year and type', async () => {
      const { data } = await call<{ passages: Passage[] }>(maya, 'search_documents', {
        query: 'interest wages mortgage',
        taxYear: 2025,
        docType: 'tax_form',
        limit: 10,
      });
      expect(data.passages.length).toBeGreaterThan(0);
      expect(new Set(data.passages.map((p) => p.documentId))).toEqual(
        new Set(['doc_petrova_1099int_2025', 'doc_kim_w2_2025', 'doc_brooks_1098_2025']),
      );
    });
  });

  describe('list_open_items', () => {
    it("lists what's still missing", async () => {
      const { data } = await call<{ status: string; items: { description: string }[] }>(tom, 'list_open_items', {
        client: 'Acme Ltd',
        taxYear: 2026,
      });
      expect(data.status).toBe('found');
      expect(data.items.map((i) => i.description)).toContain('Q4 payroll summary');
      expect(data.items.every((i) => !i.description.startsWith('Signed engagement'))).toBe(true);
    });

    it('links received items to their document', async () => {
      const { data } = await call<{ items: { description: string; document: { id: string } | null }[] }>(
        maya,
        'list_open_items',
        { client: 'cl_acme', status: 'received' },
      );
      expect(data.items[0]?.document?.id).toBe('doc_acme_engagement_2026');
    });

    it('refuses an unassigned client', async () => {
      const { data } = await call<{ status: string }>(tom, 'list_open_items', { client: 'cl_lakeside' });
      expect(data.status).toBe('denied');
      expect(await lastAudit(db)).toMatchObject({ tool: 'list_open_items', outcome: 'denied' });
    });
  });

  describe('intake: list, extract, match, file', () => {
    it('lists the inbox', async () => {
      const { data } = await call<{ documents: { id: string }[] }>(tom, 'list_inbox', {});
      expect(data.documents.map((d) => d.id).sort()).toEqual([
        'doc_inbox_blurry_statement',
        'doc_inbox_lakeside',
        'doc_inbox_northwind',
      ]);
    });

    it('extracts fields with confidences', async () => {
      const { data } = await call<{
        status: string;
        docType: string;
        clientNameOnDocument: string;
        fields: { name: string; value: string | null; confidence: number }[];
      }>(tom, 'extract_document', { documentId: 'doc_inbox_northwind' });
      expect(data.status).toBe('extracted');
      expect(data.docType).toBe('invoice');
      expect(data.clientNameOnDocument).toBe('Acme Ltd');
      const field = (name: string) => data.fields.find((f) => f.name === name)?.value;
      expect(field('invoice_number')).toBe('INV-20931');
      expect(field('total_amount')).toBe('4768.20');
      expect(field('invoice_date')).toBe('2026-11-03');
    });

    it("withholds the contents of an inbox document that belongs to someone else's client", async () => {
      const { result, data } = await call<{ status: string; fields?: unknown }>(tom, 'extract_document', {
        documentId: 'doc_inbox_lakeside',
      });
      expect(data.status).toBe('denied');
      expect(data.fields).toBeUndefined();
      expect(JSON.stringify(result.content)).not.toContain('DS-58120');
      expect(await lastAudit(db)).toMatchObject({ staff_id: 'st_tom', tool: 'extract_document', outcome: 'denied' });
    });

    it("refuses to extract a filed document for a client the user can't see", async () => {
      const { data } = await call<{ status: string }>(tom, 'extract_document', { documentId: 'doc_lakeside_software' });
      expect(data.status).toBe('denied');
    });

    it('recommends filing a clear match', async () => {
      const { data } = await call<{
        status: string;
        recommendation: string;
        candidates: { clientId: string; confidence: number; reasons: string[] }[];
      }>(tom, 'match_client', { documentId: 'doc_inbox_northwind' });
      expect(data).toMatchObject({ status: 'matched', recommendation: 'file' });
      expect(data.candidates[0]).toMatchObject({ clientId: 'cl_acme' });
      expect(data.candidates[0]!.confidence).toBeGreaterThanOrEqual(0.85);
      expect(data.candidates[0]!.reasons.join(' ')).toContain('matches exactly');
    });

    it('sends a look-alike to review instead of guessing', async () => {
      const { data } = await call<{ status: string; recommendation: string; message: string }>(maya, 'match_client', {
        documentId: 'doc_inbox_blurry_statement',
      });
      expect(data).toMatchObject({ status: 'needs_review', recommendation: 'review' });
      expect(data.message).toContain('Elena Petrov');
    });

    it("never names a candidate client the user isn't assigned to", async () => {
      // Tom has Elena Petrova but not Elena Petrovic.
      const { result, data } = await call<{
        message: string;
        hiddenCandidates: number;
        candidates: { clientId: string }[];
      }>(tom, 'match_client', { documentId: 'doc_inbox_blurry_statement' });
      expect(JSON.stringify(result)).not.toContain('Petrovic');
      expect(data.hiddenCandidates).toBe(1);
      expect(data.candidates.map((c) => c.clientId)).toEqual(['cl_petrova']);
    });

    it("denies matching a document that belongs to another team's client, and logs it", async () => {
      const { result, data } = await call<{ status: string; candidates?: unknown }>(tom, 'match_client', {
        documentId: 'doc_inbox_lakeside',
      });
      expect(data.status).toBe('denied');
      expect(data.candidates).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('Lakeside');
      expect(await lastAudit(db)).toMatchObject({ staff_id: 'st_tom', tool: 'match_client', outcome: 'denied' });
    });

    it("doesn't name a hidden look-alike when refusing to file", async () => {
      const { result, data } = await call<{ status: string }>(tom, 'file_document', {
        documentId: 'doc_inbox_blurry_statement',
        clientId: 'cl_petrova',
      });
      expect(data.status).toBe('refused');
      expect(JSON.stringify(result)).not.toContain('Petrovic');
    });

    it('refuses to file below the threshold, even when asked', async () => {
      const { data } = await call<{ status: string }>(maya, 'file_document', {
        documentId: 'doc_inbox_blurry_statement',
        clientId: 'cl_petrova',
      });
      expect(data.status).toBe('refused');
      expect((await getDocument(db, 'doc_inbox_blurry_statement'))?.status).toBe('inbox');
    });

    it('refuses to file to a client other than the clear match', async () => {
      const { data } = await call<{ status: string }>(maya, 'file_document', {
        documentId: 'doc_inbox_northwind',
        clientId: 'cl_acme_labs',
      });
      expect(data.status).toBe('refused');
    });

    it("denies filing to a client the user isn't assigned to", async () => {
      const { data } = await call<{ status: string }>(tom, 'file_document', {
        documentId: 'doc_inbox_lakeside',
        clientId: 'cl_lakeside',
      });
      expect(data.status).toBe('denied');
      expect(await lastAudit(db)).toMatchObject({ staff_id: 'st_tom', tool: 'file_document', outcome: 'denied' });
    });

    it('files the clear match and closes the open item it satisfies', async () => {
      const { data } = await call<{ status: string; document: { clientId: string }; openItemClosed: { id: string } }>(
        tom,
        'file_document',
        { documentId: 'doc_inbox_northwind', clientId: 'cl_acme', openItemId: 'oi_004' },
      );
      expect(data.status).toBe('filed');
      expect(data.document.clientId).toBe('cl_acme');
      expect(data.openItemClosed.id).toBe('oi_004');
      const doc = await getDocument(db, 'doc_inbox_northwind');
      expect(doc).toMatchObject({ status: 'filed', clientId: 'cl_acme', taxYear: 2026, docType: 'invoice' });

      // Now it's searchable.
      const { data: found } = await call<{ passages: Passage[] }>(tom, 'search_documents', {
        query: 'server rack Northwind',
      });
      expect(found.passages[0]?.documentId).toBe('doc_inbox_northwind');

      // And it can't be filed twice.
      const { data: again } = await call<{ status: string }>(tom, 'file_document', {
        documentId: 'doc_inbox_northwind',
        clientId: 'cl_acme',
      });
      expect(again.status).toBe('refused');
    });

    it('sends a document to review once', async () => {
      const first = await call<{ status: string }>(maya, 'send_to_review', {
        documentId: 'doc_inbox_blurry_statement',
        reason: 'Matches Elena Petrova and Elena Petrovic',
      });
      expect(first.data.status).toBe('sent');
      const again = await call<{ status: string }>(maya, 'send_to_review', {
        documentId: 'doc_inbox_blurry_statement',
        reason: 'again',
      });
      expect(again.data.status).toBe('already_in_review');
      const filed = await call<{ status: string }>(maya, 'send_to_review', {
        documentId: 'doc_acme_laptops',
        reason: 'not allowed',
      });
      expect(filed.data.status).toBe('not_allowed');
    });

    it('reports unknown documents', async () => {
      for (const tool of ['extract_document', 'match_client', 'send_to_review']) {
        const args =
          tool === 'send_to_review' ? { documentId: 'doc_nope', reason: 'check it' } : { documentId: 'doc_nope' };
        const { data } = await call<{ status: string }>(maya, tool, args);
        expect(data.status, tool).toBe('not_found');
      }
    });
  });

  describe('add_crm_note', () => {
    it('adds a note signed by the user', async () => {
      const { data } = await call<{ status: string; created: { kind: string; id: string } }>(tom, 'add_crm_note', {
        client: 'Acme Ltd',
        body: 'Filed the Northwind server rack invoice; closes the fixed-asset item.',
      });
      expect(data.status).toBe('added');
      const [note] = await db.query<{ author_id: string }>('select author_id from notes where id = $1', [
        data.created.id,
      ]);
      expect(note?.author_id).toBe('st_tom');
    });

    it('adds an open item with a tax year', async () => {
      const missingYear = await call<{ status: string }>(maya, 'add_crm_note', {
        client: 'cl_kim',
        body: 'Brokerage statement',
        kind: 'open_item',
      });
      expect(missingYear.data.status).toBe('invalid');
      const { data } = await call<{ status: string; created: { kind: string } }>(maya, 'add_crm_note', {
        client: 'cl_kim',
        body: 'Brokerage statement for 2026',
        kind: 'open_item',
        taxYear: 2026,
        dueDate: '2027-02-15',
      });
      expect(data).toMatchObject({ status: 'added', created: { kind: 'open_item' } });
    });

    it('refuses an unassigned client and asks on ambiguity', async () => {
      expect(
        (await call<{ status: string }>(tom, 'add_crm_note', { client: 'Lakeside', body: 'hello there' })).data.status,
      ).toBe('denied');
      expect(await lastAudit(db)).toMatchObject({ staff_id: 'st_tom', tool: 'add_crm_note', outcome: 'denied' });
      const [notes] = await db.query<{ n: number }>("select count(*)::int as n from notes where client_id = 'cl_lakeside'");
      expect(Number(notes!.n)).toBe(0);
      expect(
        (await call<{ status: string }>(maya, 'add_crm_note', { client: 'Acme', body: 'hello there' })).data.status,
      ).toBe('ambiguous');
    });
  });
});
