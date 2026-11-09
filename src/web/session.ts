import type { Request, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';

/**
 * Dashboard sessions: a short signed token (HS256, SESSION_SECRET) in an httpOnly, SameSite=Lax cookie.
 * It holds only the staff id; role and access are always re-read from the database.
 */
export const SESSION_COOKIE = 'cd_session';
const LOGIN_COOKIE = 'cd_login';
const SESSION_HOURS = 8;

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function cookieOptions(secure: boolean, maxAgeMs: number) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge: maxAgeMs };
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function issueSession(res: Response, secret: string, staffId: string, secure: boolean): Promise<void> {
  const token = await new SignJWT({ kind: 'session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(staffId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key(secret));
  res.cookie(SESSION_COOKIE, token, cookieOptions(secure, SESSION_HOURS * 3600 * 1000));
}

export async function readSession(req: Request, secret: string): Promise<string | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    return payload.kind === 'session' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** The in-flight login (state, PKCE verifier, return path), bound to this browser for 10 minutes. */
export interface PendingLogin {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
}

export async function issuePendingLogin(res: Response, secret: string, login: PendingLogin, secure: boolean) {
  const token = await new SignJWT({ kind: 'login', ...login })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('10m')
    .sign(key(secret));
  res.cookie(LOGIN_COOKIE, token, cookieOptions(secure, 10 * 60 * 1000));
}

export async function takePendingLogin(req: Request, res: Response, secret: string): Promise<PendingLogin | null> {
  const token = readCookie(req, LOGIN_COOKIE);
  res.clearCookie(LOGIN_COOKIE, { path: '/' });
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (payload.kind !== 'login') return null;
    const { state, verifier, nonce, returnTo } = payload as Record<string, unknown>;
    if ([state, verifier, nonce, returnTo].some((v) => typeof v !== 'string')) return null;
    return { state, verifier, nonce, returnTo } as PendingLogin;
  } catch {
    return null;
  }
}

/** Only same-site dashboard paths: never an absolute URL (open redirect). */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && /^\/dashboard(\/[\w\-/]*)?$/.test(value) ? value : '/dashboard/';
}
