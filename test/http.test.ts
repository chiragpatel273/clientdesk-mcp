import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/index.js';
import { createHttpApp } from '../src/http.js';
import { demoDb, TOM } from './helpers.js';

describe('HTTP transport (Streamable HTTP, stateless)', () => {
  let db: Db;
  let server: Server;
  let url: URL;

  beforeAll(async () => {
    db = await demoDb();
    const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev' });
    const app = createHttpApp({ db, config });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });

  it('serves get_client over HTTP as the user named in the dev header', async () => {
    const client = new Client({ name: 'http-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-clientdesk-user': TOM } } }),
    );
    const result = await client.callTool({ name: 'get_client', arguments: { client: 'Hana Kim' } });
    expect((result.structuredContent as { status: string }).status).toBe('found');
    await client.close();
  });

  it('rejects an unknown user with 401', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-clientdesk-user': 'stranger@example.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses dev auth in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'dev' })).toThrow(/not allowed in production/);
  });
});
