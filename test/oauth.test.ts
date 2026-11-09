import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOAuth } from '../src/auth/oauth.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/index.js';
import { createHttpApp } from '../src/http.js';
import { demoDb, MAYA, testServices, TOM } from './helpers.js';

const KID = 'test-key';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const close = (server: Server) => new Promise((resolve) => server.close(resolve));

describe('OAuth sign-in (AUTH_MODE=oauth)', () => {
  let db: Db;
  let issuerServer: Server;
  let appServer: Server;
  let issuer: string;
  let publicUrl: string;
  let mcpUrl: string;
  let signingKey: CryptoKey;
  let strangerKey: CryptoKey;

  beforeAll(async () => {
    db = await demoDb();
    const keys = await generateKeyPair('RS256');
    signingKey = keys.privateKey;
    strangerKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

    // A fake authorization server: discovery document + JWKS, like WorkOS or Auth0 would serve.
    const as = express();
    issuerServer = createServer(as);
    issuer = await listen(issuerServer);
    as.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        jwks_uri: `${issuer}/jwks`,
      });
    });
    as.get('/jwks', (_req, res) => {
      res.json({ keys: [jwk] });
    });

    // Bind first so PUBLIC_URL (and so the token audience) is known before the app is built.
    appServer = createServer();
    publicUrl = await listen(appServer);
    mcpUrl = `${publicUrl}/mcp`;
    const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'oauth', PUBLIC_URL: publicUrl, OAUTH_ISSUER: issuer });
    const oauth = await setupOAuth(config);
    appServer.on('request', createHttpApp({ db, config, oauth, services: testServices() }));
  });

  afterAll(async () => {
    await close(appServer);
    await close(issuerServer);
    await db.close();
  });

  function token(
    claims: Record<string, unknown> = {},
    options: { key?: CryptoKey; issuer?: string; audience?: string; expiresAt?: number | string } = {},
  ): Promise<string> {
    return new SignJWT({ email: TOM, client_id: 'claude-test', scope: 'openid email', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(options.issuer ?? issuer)
      .setAudience(options.audience ?? mcpUrl)
      .setSubject('user_test')
      .setIssuedAt()
      .setExpirationTime(options.expiresAt ?? '5m')
      .sign(options.key ?? signingKey);
  }

  function postMcp(headers: Record<string, string>): Promise<Response> {
    return fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  }

  const bearer = async (claims?: Record<string, unknown>, options?: Parameters<typeof token>[1]) => ({
    authorization: `Bearer ${await token(claims, options)}`,
  });

  async function connectWithToken(accessToken: string): Promise<Client> {
    const client = new Client({ name: 'oauth-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }),
    );
    return client;
  }

  async function getClientAs(email: string, client: string) {
    const mcp = await connectWithToken(await token({ email }));
    try {
      const result = await mcp.callTool({ name: 'get_client', arguments: { client } });
      return result.structuredContent as { status: string };
    } finally {
      await mcp.close();
    }
  }

  describe('discovery', () => {
    it('serves protected-resource metadata pointing at the authorization server', async () => {
      const res = await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.resource).toBe(mcpUrl);
      expect(body.authorization_servers).toEqual([issuer]);
    });

    it('answers a request without a token with 401 and a resource_metadata hint', async () => {
      const res = await postMcp({});
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain(
        `resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`,
      );
    });
  });

  describe('a valid token', () => {
    it('runs tools as the signed-in staff member', async () => {
      expect((await getClientAs(TOM, 'Hana Kim')).status).toBe('found');
    });

    it("refuses Tom a client he isn't assigned to, and logs it", async () => {
      expect((await getClientAs(TOM, 'Lakeside Dental Group')).status).toBe('denied');
      const rows = await db.query<{ outcome: string }>(
        `select outcome from audit_log where staff_id = $1 and tool = 'get_client' order by id desc limit 1`,
        ['st_tom'],
      );
      expect(rows[0]?.outcome).toBe('denied');
    });

    it('lets Maya (partner) see the same client', async () => {
      expect((await getClientAs(MAYA, 'Lakeside Dental Group')).status).toBe('found');
    });

    it('matches the email case-insensitively', async () => {
      expect((await getClientAs(TOM.toUpperCase(), 'Hana Kim')).status).toBe('found');
    });
  });

  describe('rejected tokens (401)', () => {
    // Functions, because the keys only exist once beforeAll has run.
    it.each<[string, () => Parameters<typeof token>[1]]>([
      ['wrong audience', () => ({ audience: 'https://some-other-api.example' })],
      ['wrong issuer', () => ({ issuer: 'https://evil.example' })],
      ['expired', () => ({ expiresAt: Math.floor(Date.now() / 1000) - 60 })],
      ['signed by an unknown key', () => ({ key: strangerKey })],
    ])('%s', async (_label, options) => {
      const res = await postMcp(await bearer({}, options()));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    });

    it('rejects a token that is not a JWT', async () => {
      expect((await postMcp({ authorization: 'Bearer not-a-jwt' })).status).toBe(401);
    });
  });

  describe('signed in but not staff (403)', () => {
    it('refuses an email with no staff record', async () => {
      const res = await postMcp(await bearer({ email: 'stranger@example.com' }));
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toContain('not a ClientDesk staff member');
    });

    it('refuses a token without an email claim', async () => {
      const res = await postMcp(await bearer({ email: undefined }));
      expect(res.status).toBe(403);
    });
  });

  describe('origin check', () => {
    it('refuses a browser request from an unknown origin', async () => {
      const res = await postMcp({ ...(await bearer()), origin: 'https://evil.example' });
      expect(res.status).toBe(403);
    });

    it("accepts this server's own origin", async () => {
      const res = await postMcp({ ...(await bearer()), origin: publicUrl });
      expect(res.status).toBe(200);
    });
  });

  describe('config', () => {
    it('requires PUBLIC_URL and OAUTH_ISSUER in oauth mode', () => {
      expect(() => loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'oauth' })).toThrow(/PUBLIC_URL and OAUTH_ISSUER/);
    });

    it('requires https in production', () => {
      expect(() =>
        loadConfig({
          NODE_ENV: 'production',
          AUTH_MODE: 'oauth',
          PUBLIC_URL: 'http://clientdesk.example',
          OAUTH_ISSUER: 'https://auth.example',
        }),
      ).toThrow(/https/);
    });

    it('fails at start-up when the issuer metadata names a different issuer', async () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'oauth',
        PUBLIC_URL: publicUrl,
        OAUTH_ISSUER: `${issuer.replace('127.0.0.1', 'localhost')}`,
      });
      await expect(setupOAuth(config)).rejects.toThrow(/metadata names/);
    });
  });
});
