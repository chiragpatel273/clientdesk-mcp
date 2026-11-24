/**
 * The server in AUTH_MODE=oauth, as deployed, next to a tiny fake sign-in provider (discovery, authorize, token, JWKS)
 * standing in for WorkOS. Lets the E2E suite use the real sign-in page. Started by playwright.config.ts; offline.
 * The provider signs everyone in as Maya and checks PKCE, the client secret and the redirect URI like a real one.
 */
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const ISSUER_PORT = Number(process.env.E2E_ISSUER_PORT);
const issuer = `http://localhost:${ISSUER_PORT}`;
const client = { id: process.env.DASHBOARD_CLIENT_ID!, secret: process.env.DASHBOARD_CLIENT_SECRET! };
const redirectUri = `${process.env.PUBLIC_URL}/auth/callback`;

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'e2e', alg: 'RS256', use: 'sig' };
const codes = new Map<string, { nonce: string; challenge: string }>();

const as = express();
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
as.get('/jwks', (_req, res) => void res.json({ keys: [jwk] }));
as.get('/authorize', (req, res) => {
  const q = req.query as Record<string, string>;
  if (q.client_id !== client.id || q.redirect_uri !== redirectUri || q.code_challenge_method !== 'S256') {
    res.status(400).send('bad authorize request');
    return;
  }
  const code = randomBytes(16).toString('hex');
  codes.set(code, { nonce: q.nonce!, challenge: q.code_challenge! });
  res.redirect(`${redirectUri}?code=${code}&state=${encodeURIComponent(q.state!)}`);
});
as.post('/token', express.urlencoded({ extended: false }), async (req, res) => {
  const b = req.body as Record<string, string>;
  const pending = codes.get(b.code!);
  codes.delete(b.code!); // single use
  const challenge = createHash('sha256')
    .update(b.code_verifier ?? '')
    .digest('base64url');
  if (!pending || b.client_id !== client.id || b.client_secret !== client.secret || challenge !== pending.challenge) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  const idToken = await new SignJWT({ email: 'maya@northbridge.example', nonce: pending.nonce })
    .setProtectedHeader({ alg: 'RS256', kid: 'e2e' })
    .setIssuer(issuer)
    .setAudience(client.id)
    .setSubject('e2e-maya')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  res.json({ id_token: idToken, access_token: 'unused', token_type: 'Bearer' });
});
await new Promise<void>((resolve) => as.listen(ISSUER_PORT, () => resolve()));

// The first web server builds the dashboard; this one serves the same build, so wait for it.
const first = process.env.E2E_WAIT_FOR!;
for (let i = 0; i < 180; i++) {
  if (
    await fetch(first).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await import('../src/main.js');
