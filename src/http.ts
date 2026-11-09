import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { OAuthSetup } from './auth/oauth.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { projectRoot } from './db/migrate.js';
import { recordAudit } from './domain/audit.js';
import { getDocument } from './domain/documents.js';
import { findActorByEmail } from './domain/staff.js';
import type { Actor } from './domain/types.js';
import { ensureMatch } from './domain/intake.js';
import { canSeeDocument } from './mcp/document-access.js';
import { createMcpServer } from './mcp/server.js';
import type { AppServices } from './services.js';
import { createApiRouter, sendDocumentFile } from './web/api.js';
import { mountDashboardAuth } from './web/dashboard-auth.js';

const DEV_USER_HEADER = 'x-clientdesk-user';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

type ActorResult = { actor: Actor } | { status: 401 | 403; message: string };

/**
 * Works out who is calling. This is the only place identity is decided.
 * - `oauth`: the bearer token was already verified by `requireBearerAuth`; its email claim picks the staff member.
 * - `dev`: a header (or DEV_USER) names the staff member. Refused in production by `loadConfig`.
 */
async function resolveActor(req: Request, db: Db, config: Config): Promise<ActorResult> {
  if (config.authMode === 'oauth') {
    if (!req.auth) return { status: 401, message: 'Sign-in required.' };
    const email = req.auth.extra?.email;
    if (typeof email !== 'string') {
      return {
        status: 403,
        message: 'Your sign-in did not include an email address, so ClientDesk cannot tell who you are.',
      };
    }
    const actor = await findActorByEmail(db, email);
    return actor
      ? { actor }
      : { status: 403, message: 'This account is not a ClientDesk staff member. Ask a partner to add you.' };
  }
  const actor = await findActorByEmail(db, req.header(DEV_USER_HEADER) ?? config.devUser);
  return actor ? { actor } : { status: 401, message: 'Unknown or missing user.' };
}

/**
 * Browsers always send `Origin`; server-to-server callers (Claude's connector backend) usually don't.
 * A present but unknown origin is refused, so a web page can't drive the server with a user's credentials.
 */
function originCheck(config: Config): RequestHandler {
  const allowed = new Set(config.allowedOrigins);
  const isAllowed = (origin: string): boolean => {
    if (allowed.has(origin)) return true;
    if (config.authMode !== 'dev') return false;
    try {
      return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
    } catch {
      return false;
    }
  };
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin');
    if (origin !== undefined && !isAllowed(origin)) {
      jsonRpcError(res, 403, -32000, 'Origin not allowed.');
      return;
    }
    next();
  };
}

export interface HttpDeps {
  db: Db;
  config: Config;
  services: AppServices;
  oauth?: OAuthSetup;
  /** Where `dashboard/dist` and `eval/report.json` live. Defaults to the repo root. */
  projectRoot?: string;
}

export function createHttpApp(deps: HttpDeps): Express {
  const { db, config, services, oauth } = deps;
  const root = deps.projectRoot ?? projectRoot();
  if (config.authMode === 'oauth' && !oauth) throw new Error('AUTH_MODE=oauth needs an OAuth setup (setupOAuth).');

  const app = createMcpExpressApp(config.allowedHosts ? { allowedHosts: config.allowedHosts } : {});
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    // Signed document links must never leak through the Referer header; nothing here should be framed.
    res.set({ 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, name: 'clientdesk', authMode: config.authMode });
  });

  const authenticate: RequestHandler[] = [];
  if (oauth) {
    // Discovery: Claude reads /.well-known/oauth-protected-resource/mcp to find the authorization server.
    app.use(
      mcpAuthMetadataRouter({
        oauthMetadata: oauth.metadata,
        resourceServerUrl: oauth.resourceUrl,
        resourceName: 'ClientDesk (Northbridge Advisory)',
      }),
    );
    authenticate.push(
      requireBearerAuth({
        verifier: oauth.verifier,
        // A 401 points the client at the metadata above, which starts the sign-in flow.
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(oauth.resourceUrl),
      }),
    );
  }

  app.use(['/mcp', '/api', '/auth'], originCheck(config));

  // Stateless Streamable HTTP: a fresh server per request, bound to that request's caller.
  app.post('/mcp', ...authenticate, async (req, res) => {
    const result = await resolveActor(req, db, config);
    if (!('actor' in result)) {
      jsonRpcError(res, result.status, -32001, result.message);
      return;
    }
    const server = createMcpServer({ db, actor: result.actor, services });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed', error);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => jsonRpcError(res, 405, -32000, 'Method not allowed.');
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // Signed citation links from tool results. The signature names a staff member; their access is re-checked now.
  app.get('/files/:id', async (req, res) => {
    const documentId = String(req.params.id);
    const staffId = String(req.query.u ?? '');
    const expires = Number(req.query.exp);
    const signature = String(req.query.sig ?? '');
    if (!services.links.verify(documentId, staffId, expires, signature)) {
      res.status(403).type('text/plain').send('This link is invalid or has expired. Ask Claude for a fresh one.');
      return;
    }
    const [staff] = await db.query<{ email: string }>('select email from staff where id = $1', [staffId]);
    const actor = staff ? await findActorByEmail(db, staff.email) : null;
    const doc = await getDocument(db, documentId);
    if (!actor || !doc) {
      res.status(404).type('text/plain').send('Document not found.');
      return;
    }
    const access = await canSeeDocument({ db, actor }, doc, await ensureMatch(db, services, doc));
    await recordAudit(db, {
      staffId: actor.staffId,
      tool: 'download_document',
      input: { documentId },
      outcome: access.allowed ? 'ok' : 'denied',
      detail: access.allowed ? undefined : access.detail,
      durationMs: 0,
    });
    if (!access.allowed) {
      res.status(403).type('text/plain').send(access.reason);
      return;
    }
    await sendDocumentFile(res, services, doc);
  });

  // The staff dashboard: sign-in, JSON API and the built React app.
  mountDashboardAuth(app, { db, config, oauth });
  app.use('/api', createApiRouter({ db, config, services, projectRoot: root }));
  const dist = join(root, 'dashboard', 'dist');
  if (existsSync(join(dist, 'index.html'))) {
    app.use('/dashboard', express.static(dist, { index: 'index.html', maxAge: '1h' }));
    app.get(/^\/dashboard(\/.*)?$/, (_req, res) => res.sendFile(join(dist, 'index.html')));
    app.get('/', (_req, res) => res.redirect('/dashboard/'));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Request failed', err instanceof Error ? err.message : err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
