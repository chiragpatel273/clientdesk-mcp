import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/index.js';
import { createHttpApp } from '../src/http.js';
import { demoDb, testServices } from './helpers.js';

describe('serving the dashboard after a deploy', () => {
  let db: Db;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'clientdesk-dist-'));
    mkdirSync(join(root, 'dashboard', 'dist', 'assets'), { recursive: true });
    writeFileSync(join(root, 'dashboard', 'dist', 'index.html'), '<!doctype html><title>ClientDesk</title>');
    writeFileSync(join(root, 'dashboard', 'dist', 'assets', 'index-abc123.js'), 'console.log(1)');
    db = await demoDb();
    const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev' });
    const app = createHttpApp({ db, config, services: testServices(), projectRoot: root });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });

  it('the page is always checked for a newer version; its hashed files are kept', async () => {
    for (const path of ['/dashboard/', '/dashboard/inbox']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
      expect(res.headers.get('etag'), path).toBeTruthy();
    }
    const asset = await fetch(`${base}/dashboard/assets/index-abc123.js`);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('a file from an older version is missing, not the page pretending to be it', async () => {
    const res = await fetch(`${base}/dashboard/assets/index-old999.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<!doctype html><title>ClientDesk');
  });
});
