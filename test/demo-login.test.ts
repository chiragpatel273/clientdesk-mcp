import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { createHttpApp } from '../src/http.js';
import type { AppServices } from '../src/services.js';
import { resolveDashboardActor } from '../src/web/api.js';
import { rateLimit } from '../src/web/rate-limit.js';
import { call, connectAs, demoDb, demoDbWithDocuments, lastAudit, testServices } from './helpers.js';

const DEMO = 'demo@northbridge.example';
const SECRET = 'test-session-secret-test-session-secret-00';

async function listen(app: ReturnType<typeof createHttpApp>): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('Try the demo (read-only demo session)', () => {
  let db: Db;
  let services: AppServices;
  let on: { server: Server; base: string };
  let off: { server: Server; base: string };

  beforeAll(async () => {
    services = testServices();
    db = await demoDbWithDocuments(services);
    const config = (demo: boolean) =>
      loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', DEMO_LOGIN: demo ? 'true' : 'false', SESSION_SECRET: SECRET });
    on = await listen(createHttpApp({ db, config: config(true), services, projectRoot: '/nonexistent' }));
    off = await listen(createHttpApp({ db, config: config(false), services, projectRoot: '/nonexistent' }));
  });

  afterAll(async () => {
    await Promise.all([on, off].map(({ server }) => new Promise((resolve) => server.close(resolve))));
    await db.close();
  });

  const startDemo = async (base = on.base) => {
    const res = await fetch(`${base}/auth/demo`, { method: 'POST', headers: { 'x-clientdesk-csrf': '1' } });
    return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const api = (path: string, cookie: string, init: RequestInit = {}, base = on.base) =>
    fetch(`${base}${path}`, { ...init, headers: { cookie, ...(init.headers as Record<string, string>) } });

  it('is off by default and says so to the sign-in page', async () => {
    expect(loadConfig({ NODE_ENV: 'test' }).demoLogin).toBe(false);
    expect(await (await fetch(`${off.base}/auth/options`)).json()).toEqual({ demoLogin: false });
    expect(await (await fetch(`${on.base}/auth/options`)).json()).toEqual({ demoLogin: true });
    expect((await startDemo(off.base)).res.status).toBe(404);
  });

  it('needs the CSRF header', async () => {
    expect((await fetch(`${on.base}/auth/demo`, { method: 'POST' })).status).toBe(403);
  });

  it('signs in as the read-only demo visitor and audits the sign-in', async () => {
    const { res, cookie } = await startDemo();
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/cd_session=.*HttpOnly/i);
    expect(await lastAudit(db)).toMatchObject({ staff_id: 'st_demo', tool: 'auth:demo_login', outcome: 'ok' });

    const me = await (await api('/api/me', cookie)).json();
    expect(me).toMatchObject({ staffId: 'st_demo', role: 'partner', readOnly: true });
  });

  it('can read every dashboard page like a partner', async () => {
    const { cookie } = await startDemo();
    for (const path of ['/api/stats', '/api/audit', '/api/review', '/api/inbox']) {
      expect((await api(path, cookie)).status, path).toBe(200);
    }
    const stats = (await (await api('/api/stats', cookie)).json()) as { documents: { filed: number } };
    expect(stats.documents.filed).toBe(10); // a partner-level view: every client's documents
    expect((await api('/api/documents/doc_lakeside_software/file', cookie)).status).toBe(200);
  });

  it('refuses every write, before reading the body, and audits each refusal', async () => {
    const { cookie } = await startDemo();
    const before = await db.query<{ n: number }>('select count(*)::int as n from documents');

    const resolve = await api('/api/review/doc_inbox_blurry_statement/resolve', cookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clientdesk-csrf': '1' },
      body: JSON.stringify({ clientId: 'cl_petrova' }),
    });
    expect(resolve.status).toBe(403);
    expect(await lastAudit(db)).toMatchObject({
      staff_id: 'st_demo',
      tool: 'dashboard:resolve_review',
      outcome: 'denied',
      detail: 'read-only session',
    });

    const upload = await api('/api/documents', cookie, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-filename': 'x.txt', 'x-clientdesk-csrf': '1' },
      body: 'INVOICE\nTotal due: $1.00',
    });
    expect(upload.status).toBe(403);
    expect(await lastAudit(db)).toMatchObject({ tool: 'dashboard:upload', outcome: 'denied' });

    // Without the CSRF header too: still refused, and still in the audit log.
    const noCsrf = await api('/api/batches', cookie, { method: 'POST' });
    expect(noCsrf.status).toBe(403);
    expect(await lastAudit(db)).toMatchObject({
      staff_id: 'st_demo',
      tool: 'dashboard:create_batch',
      outcome: 'denied',
      detail: 'read-only session',
    });

    // Any other write route, including ones added later, is refused the same way.
    const other = await api('/api/anything', cookie, { method: 'POST', headers: { 'x-clientdesk-csrf': '1' } });
    expect(other.status).toBe(403);
    expect(await lastAudit(db)).toMatchObject({ tool: 'dashboard:write', outcome: 'denied' });

    expect(await db.query<{ n: number }>('select count(*)::int as n from documents')).toEqual(before);
  });

  it('stops honouring demo sessions once DEMO_LOGIN is turned off', async () => {
    const { cookie } = await startDemo();
    // Same secret, flag off: the cookie no longer signs anyone in, so dev mode falls back to the default user.
    const me = (await (await api('/api/me', cookie, {}, off.base)).json()) as { staffId: string };
    expect(me.staffId).toBe('st_maya');
  });

  it('keeps the demo visitor out of the dev user picker', async () => {
    const res = await fetch(`${on.base}/api/staff`);
    const { staff } = (await res.json()) as { staff: { email: string }[] };
    expect(staff.map((s) => s.email)).not.toContain(DEMO);
  });

  it('is rate-limited per address', async () => {
    const limited = await listen(
      createHttpApp({
        db,
        config: loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', DEMO_LOGIN: 'true', SESSION_SECRET: SECRET }),
        services,
        projectRoot: '/nonexistent',
      }),
    );
    try {
      const statuses = [];
      for (let i = 0; i < 6; i++) statuses.push((await startDemo(limited.base)).res.status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    } finally {
      await new Promise((resolve) => limited.server.close(resolve));
    }
  });

  it('refuses MCP write tools for the demo visitor, with an audit row, but allows reads', async () => {
    const client = await connectAs(db, DEMO, services);
    try {
      const writes: [string, Record<string, unknown>][] = [
        ['file_document', { documentId: 'doc_inbox_northwind', clientId: 'cl_acme' }],
        ['send_to_review', { documentId: 'doc_inbox_northwind', reason: 'testing the demo' }],
        ['add_crm_note', { client: 'cl_acme', body: 'testing the demo' }],
      ];
      for (const [tool, args] of writes) {
        const { data } = await call<{ status: string }>(client, tool, args);
        expect(data.status, tool).toBe('denied');
        expect(await lastAudit(db), tool).toMatchObject({
          staff_id: 'st_demo',
          tool,
          outcome: 'denied',
          detail: 'read-only session',
        });
      }
      const [doc] = await db.query<{ status: string }>('select status from documents where id = $1', [
        'doc_inbox_northwind',
      ]);
      expect(doc?.status).toBe('inbox');

      const { data } = await call<{ status: string }>(client, 'get_client', { client: 'Lakeside Dental Group' });
      expect(data.status).toBe('found');
    } finally {
      await client.close();
    }
  });
});

describe('resolveDashboardActor in oauth mode', () => {
  it('reads only the session cookie, never the dev header', async () => {
    const db = await demoDb();
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'oauth',
      PUBLIC_URL: 'https://clientdesk.example',
      OAUTH_ISSUER: 'https://auth.example',
      DEMO_LOGIN: 'true',
      SESSION_SECRET: SECRET,
    });
    const req = (headers: Record<string, string>) =>
      ({ headers, header: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;
    expect(await resolveDashboardActor(req({ 'x-clientdesk-user': 'maya@northbridge.example' }), db, config)).toBe(
      null,
    );
    await db.close();
  }, 30_000);
});

describe('demo visitor on an existing database', () => {
  it('is added on start-up to a database seeded before v2', async () => {
    const db = await createDb('pglite://memory');
    await migrate(db);
    await seedDemo(db, () => {}, testServices());
    await db.query(`delete from audit_log where staff_id = 'st_demo'`);
    await db.query(`delete from staff where id = 'st_demo'`);
    const logs: string[] = [];
    await seedDemo(db, (m) => logs.push(m), testServices());
    expect(logs).toEqual(['Added the read-only demo visitor.']);
    const [row] = await db.query<{ read_only: boolean; role: string }>(
      `select read_only, role from staff where id = 'st_demo'`,
    );
    expect(row).toEqual({ read_only: true, role: 'partner' });
    await db.close();
  }, 60_000);
});

describe('rateLimit', () => {
  it('allows max requests per window, then answers 429 with Retry-After until the window ends', () => {
    let t = 0;
    const limiter = rateLimit([{ max: 2, windowMs: 1000 }], { now: () => t });
    const run = () => {
      let status = 200;
      const headers: Record<string, string> = {};
      const res = {
        status(code: number) {
          status = code;
          return this;
        },
        set(name: string, value: string) {
          headers[name] = value;
          return this;
        },
        json() {
          return this;
        },
      };
      let passed = false;
      limiter({ ip: '1.2.3.4' } as Request, res as never, () => {
        passed = true;
      });
      return { passed, status, headers };
    };
    expect(run().passed).toBe(true);
    expect(run().passed).toBe(true);
    const blocked = run();
    expect(blocked).toMatchObject({ passed: false, status: 429, headers: { 'retry-after': '1' } });
    t = 1000;
    expect(run().passed).toBe(true);
  });
});
