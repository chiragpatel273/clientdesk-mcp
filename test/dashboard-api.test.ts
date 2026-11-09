import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/index.js';
import { createHttpApp } from '../src/http.js';
import type { AppServices } from '../src/services.js';
import { demoDbWithDocuments, MAYA, testServices, TOM } from './helpers.js';

describe('dashboard API and document links (dev auth)', () => {
  let db: Db;
  let server: Server;
  let base: string;
  let services: AppServices;

  beforeAll(async () => {
    services = testServices();
    db = await demoDbWithDocuments(services);
    const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev' });
    // A project root with no dashboard build or report, so those paths behave as on a fresh checkout.
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

  const api = (path: string, user: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { 'x-clientdesk-user': user, ...(init.headers as Record<string, string>) },
    });
  const post = (path: string, user: string, body: unknown, csrf = true) =>
    api(path, user, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(csrf ? { 'x-clientdesk-csrf': '1' } : {}) },
      body: JSON.stringify(body),
    });

  it('says who is signed in', async () => {
    const res = await api('/api/me', TOM);
    expect(await res.json()).toMatchObject({ staffId: 'st_tom', role: 'assistant', authMode: 'dev' });
    expect((await api('/api/me', 'stranger@example.com')).status).toBe(401);
  });

  it('reports document counts', async () => {
    const body = (await (await api('/api/stats', MAYA)).json()) as { documents: Record<string, number> };
    expect(body.documents).toMatchObject({ inbox: 3, filed: 10, review: 0 });
  });

  it('shows assistants only their own audit rows', async () => {
    await api('/api/documents/doc_lakeside_software/file', TOM); // a denied view, logged as Tom
    const tom = (await (await api('/api/audit', TOM)).json()) as { rows: { staff: { id: string }; detail: string | null }[] };
    expect(tom.rows.length).toBeGreaterThan(0);
    expect(tom.rows.every((r) => r.staff.id === 'st_tom')).toBe(true);
    expect(tom.rows.every((r) => r.detail === null)).toBe(true); // details can name other clients
    const maya = (await (await api('/api/audit?outcome=denied', MAYA)).json()) as {
      rows: { tool: string; outcome: string }[];
    };
    expect(maya.rows[0]).toMatchObject({ tool: 'dashboard:view_document', outcome: 'denied' });
  });

  it('rejects state changes without the CSRF header', async () => {
    expect((await post('/api/review/doc_x/resolve', MAYA, { clientId: 'cl_acme' }, false)).status).toBe(403);
  });

  it('refuses a cross-site origin', async () => {
    const res = await api('/api/me', MAYA, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('uploads a document to the inbox', async () => {
    const res = await api('/api/documents', TOM, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-filename': 'note.txt', 'x-clientdesk-csrf': '1' },
      body: 'INVOICE\nInvoice number: Z-1\nBill to: Hana Kim\nTotal due: $10.00',
    });
    const body = (await res.json()) as { id: string; duplicate: boolean };
    expect(res.status).toBe(200);
    expect(body.duplicate).toBe(false);
    const inbox = (await (await api('/api/inbox', TOM)).json()) as { items: { id: string }[] };
    expect(inbox.items.map((i) => i.id)).toContain(body.id);
  });

  it('rejects unsupported uploads', async () => {
    const res = await api('/api/documents', TOM, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-clientdesk-csrf': '1' },
      body: 'png',
    });
    expect(res.status).toBe(415);
  });

  it('lets only partners resolve a review, and files the document', async () => {
    await db.query(
      `update documents set status = 'review', review_reason = 'look-alike', sent_to_review_by = 'st_tom', sent_to_review_at = now()
       where id = 'doc_inbox_blurry_statement'`,
    );
    const queue = (await (await api('/api/review', TOM)).json()) as { items: { id: string }[] };
    expect(queue.items.map((i) => i.id)).toEqual(['doc_inbox_blurry_statement']);

    expect((await post('/api/review/doc_inbox_blurry_statement/resolve', TOM, { clientId: 'cl_petrova' })).status).toBe(
      403,
    );
    const ok = await post('/api/review/doc_inbox_blurry_statement/resolve', MAYA, {
      clientId: 'cl_petrova',
      taxYear: 2026,
    });
    expect(ok.status).toBe(200);
    const [doc] = await db.query<{ status: string; client_id: string; filed_by: string }>(
      'select status, client_id, filed_by from documents where id = $1',
      ['doc_inbox_blurry_statement'],
    );
    expect(doc).toEqual({ status: 'filed', client_id: 'cl_petrova', filed_by: 'st_maya' });
  });

  it('serves a signed citation link, and only to someone who may see it', async () => {
    const good = services.links.url('doc_acme_laptops', 'st_tom');
    // The link points at the signer's base (localhost:3000); request the same path from the test server.
    const local = await fetch(`${base}${new URL(good).pathname}${new URL(good).search}`);
    expect(local.status).toBe(200);
    expect(local.headers.get('content-type')).toBe('application/pdf');
    expect(local.headers.get('referrer-policy')).toBe('no-referrer');

    const tampered = new URL(good);
    tampered.searchParams.set('u', 'st_maya');
    expect((await fetch(`${base}${tampered.pathname}${tampered.search}`)).status).toBe(403);

    // A validly signed link for a document Tom can't see is still refused.
    const forbidden = new URL(services.links.url('doc_lakeside_software', 'st_tom'));
    expect((await fetch(`${base}${forbidden.pathname}${forbidden.search}`)).status).toBe(403);
  });

  it("won't show an assistant an unmatched inbox file that belongs to another team's client", async () => {
    // Nobody has extracted or matched this one yet; viewing it must still follow the same rule as extract_document.
    await db.query('update documents set extraction = null, match = null where id = $1', ['doc_inbox_lakeside']);
    expect((await api('/api/documents/doc_inbox_lakeside/file', TOM)).status).toBe(403);
    expect((await api('/api/documents/doc_inbox_lakeside/file', MAYA)).status).toBe(200);
    const link = new URL(services.links.url('doc_inbox_lakeside', 'st_tom'));
    expect((await fetch(`${base}${link.pathname}${link.search}`)).status).toBe(403);
  });

  it('returns 404 for the accuracy report before the first eval run', async () => {
    expect((await api('/api/accuracy', MAYA)).status).toBe(404);
  });
});
