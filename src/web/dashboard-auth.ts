import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { jwtVerify } from 'jose';
import type { OAuthSetup } from '../auth/oauth.js';
import { baseUrl, type Config } from '../config.js';
import type { Db } from '../db/index.js';
import { recordAudit } from '../domain/audit.js';
import { DEMO_VISITOR } from '../demo/firm.js';
import { findActorByEmail, findActorById } from '../domain/staff.js';
import { CSRF_HEADER } from './api.js';
import { rateLimit } from './rate-limit.js';
import { clearSession, issuePendingLogin, issueSession, safeReturnTo, takePendingLogin } from './session.js';

const b64url = (bytes: Buffer) => bytes.toString('base64url');

/**
 * Dashboard sign-in. In `dev` mode there is nothing to do (the dashboard sends the dev header).
 * In `oauth` mode: authorization code + PKCE against the same provider Claude uses, with a regular
 * (confidential) client for the dashboard. The ID token's email picks the staff member, exactly like the MCP side.
 */
export function mountDashboardAuth(app: Express, deps: { db: Db; config: Config; oauth?: OAuthSetup }): void {
  const { db, config, oauth } = deps;
  const secure = baseUrl(config).protocol === 'https:';
  const redirectUri = new URL('/auth/callback', baseUrl(config)).href;

  const fail = (res: Response, status: number, message: string) =>
    res.status(status).type('text/plain').send(`${message}\n\nReturn to /dashboard/ to try again.`);

  app.get('/auth/login', async (req: Request, res: Response) => {
    const returnTo = safeReturnTo(req.query.returnTo);
    if (config.authMode === 'dev') return res.redirect(returnTo);
    if (!oauth || !config.dashboardClient) {
      return fail(
        res,
        503,
        'Dashboard sign-in is not configured: set DASHBOARD_CLIENT_ID and DASHBOARD_CLIENT_SECRET.',
      );
    }
    const login = {
      state: b64url(randomBytes(24)),
      verifier: b64url(randomBytes(32)),
      nonce: b64url(randomBytes(16)),
      returnTo,
    };
    await issuePendingLogin(res, config.sessionSecret, login, secure);
    const url = new URL(oauth.metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.dashboardClient.id);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', login.state);
    url.searchParams.set('nonce', login.nonce);
    url.searchParams.set('code_challenge', b64url(createHash('sha256').update(login.verifier).digest()));
    url.searchParams.set('code_challenge_method', 'S256');
    return res.redirect(url.href);
  });

  app.get('/auth/callback', async (req: Request, res: Response) => {
    if (!oauth || !config.dashboardClient) return fail(res, 503, 'Dashboard sign-in is not configured.');
    const login = await takePendingLogin(req, res, config.sessionSecret);
    if (!login || typeof req.query.code !== 'string' || req.query.state !== login.state) {
      return fail(res, 400, 'Sign-in expired or was started in another browser.');
    }
    const tokenRes = await fetch(oauth.metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: redirectUri,
        client_id: config.dashboardClient.id,
        client_secret: config.dashboardClient.secret,
        code_verifier: login.verifier,
      }),
    });
    if (!tokenRes.ok) return fail(res, 502, 'The sign-in provider did not accept the login.');
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token)
      return fail(res, 502, 'The sign-in provider returned no ID token (is the openid scope allowed?).');

    let email: unknown;
    try {
      const { payload } = await jwtVerify(tokens.id_token, oauth.keys, {
        issuer: oauth.metadata.issuer,
        audience: config.dashboardClient.id,
      });
      if (payload.nonce !== login.nonce) throw new Error('nonce mismatch');
      email = payload.email;
    } catch {
      return fail(res, 401, 'The sign-in could not be verified.');
    }
    const actor = typeof email === 'string' ? await findActorByEmail(db, email) : null;
    if (!actor) return fail(res, 403, 'This account is not a ClientDesk staff member.');
    await issueSession(res, config.sessionSecret, actor.staffId, secure);
    return res.redirect(login.returnTo);
  });

  // What the sign-in page may offer. Public: it reveals only whether the demo button is on.
  app.get('/auth/options', (_req: Request, res: Response) => {
    res.json({ demoLogin: config.demoLogin });
  });

  // "Try the demo": a short read-only session as the demo visitor. Rate-limited per IP; every sign-in is audited.
  const demoLimiter = rateLimit(
    [
      { max: 5, windowMs: 60_000 },
      { max: 30, windowMs: 3_600_000 },
    ],
    { message: 'Too many demo sign-ins from this address. Try again in a few minutes.' },
  );
  app.post('/auth/demo', (req: Request, res: Response, next) => {
    if (!config.demoLogin) return res.status(404).json({ error: 'Demo sign-in is not enabled.' });
    if (req.header(CSRF_HEADER) !== '1') return res.status(403).json({ error: 'Missing CSRF header' });
    return demoLimiter(req, res, next);
  });
  app.post('/auth/demo', async (_req: Request, res: Response) => {
    const actor = await findActorById(db, DEMO_VISITOR.id);
    if (!actor?.readOnly) {
      return res.status(503).json({ error: 'The demo visitor is not set up. Start the server with SEED_DEMO=1.' });
    }
    await issueSession(res, config.sessionSecret, actor.staffId, secure, { demo: true });
    await recordAudit(db.forFirm(actor.firmId), {
      staffId: actor.staffId,
      tool: 'auth:demo_login',
      input: null,
      outcome: 'ok',
      durationMs: 0,
    });
    return res.json({ ok: true });
  });

  app.post('/auth/logout', (_req: Request, res: Response) => {
    clearSession(res);
    res.json({ ok: true });
  });
}
