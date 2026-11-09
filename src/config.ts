import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const list = (value: string | undefined): string[] | undefined =>
  value
    ?.split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const secret = z.string().min(32, 'must be at least 32 characters');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * `pglite://memory` for tests, `pglite://<dir>` for local development,
   * or a normal `postgres://` URL (Neon) in production.
   */
  DATABASE_URL: z.string().default('pglite://.data/pglite'),
  /**
   * `oauth` validates a bearer token from the authorization server (WorkOS AuthKit, Auth0...).
   * `dev` trusts an `x-clientdesk-user` header (or DEV_USER) for local work and tests; it is refused in production.
   */
  AUTH_MODE: z.enum(['dev', 'oauth']).default('dev'),
  DEV_USER: z.string().email().default('maya@northbridge.example'),
  /** This server's public origin, e.g. `https://clientdesk.example.com` or the ngrok URL. The MCP endpoint is `/mcp`. */
  PUBLIC_URL: z.url().optional(),
  /** The authorization server's issuer, e.g. `https://<subdomain>.authkit.app` or `https://<tenant>.auth0.com/`. */
  OAUTH_ISSUER: z.url().optional(),
  /** Defaults to the `jwks_uri` from the issuer's discovery document. */
  OAUTH_JWKS_URL: z.url().optional(),
  /** The `aud` the token must carry. Defaults to the MCP endpoint URL (`PUBLIC_URL` + `/mcp`). */
  OAUTH_AUDIENCE: z.string().min(1).optional(),
  /** The access-token claim holding the user's email (Auth0 needs a namespaced custom claim). */
  OAUTH_EMAIL_CLAIM: z.string().min(1).default('email'),
  /** A regular (non-DCR) OAuth client for the dashboard's own sign-in. Redirect URI: `PUBLIC_URL/auth/callback`. */
  DASHBOARD_CLIENT_ID: z.string().min(1).optional(),
  DASHBOARD_CLIENT_SECRET: z.string().min(1).optional(),
  /** Signs dashboard session cookies. */
  SESSION_SECRET: secret.optional(),
  /** Signs the short-lived document links that tools return. */
  LINK_SECRET: secret.optional(),
  /** Comma-separated host names the HTTP server answers to (DNS-rebinding protection). */
  ALLOWED_HOSTS: z.string().optional(),
  /** Comma-separated browser origins allowed to call `/mcp`. `PUBLIC_URL`'s origin is always allowed. */
  ALLOWED_ORIGINS: z.string().optional(),
  /** Seed the fictional Northbridge Advisory data on start when the database is empty. */
  SEED_DEMO: z
    .enum(['0', '1'])
    .default('1')
    .transform((v) => v === '1'),

  /** `claude` needs ANTHROPIC_API_KEY; `rules` is the offline extractor used in tests and CI. `auto` picks. */
  EXTRACTOR: z.enum(['auto', 'claude', 'rules']).default('auto'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** `voyage` needs VOYAGE_API_KEY; `local` is a deterministic hashing embedder for tests and offline use. */
  EMBEDDINGS: z.enum(['auto', 'voyage', 'local']).default('auto'),
  VOYAGE_API_KEY: z.string().min(1).optional(),

  /** `local` writes under FILES_DIR; `r2` uses Cloudflare R2 (S3 API). */
  STORAGE: z.enum(['local', 'r2']).default('local'),
  FILES_DIR: z.string().default('.data/files'),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),

  /** A document is filed automatically only when the best client scores at least this... */
  FILE_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.85),
  /** ...and beats the runner-up by at least this much. Otherwise it goes to human review. */
  FILE_MARGIN: z.coerce.number().min(0).max(1).default(0.15),
});

export type OAuthConfig = {
  issuer: string;
  jwksUrl: string | undefined;
  audience: string;
  emailClaim: string;
};

export type R2Config = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };

export type Config = {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  authMode: 'dev' | 'oauth';
  devUser: string;
  /** Public origin of this server, when known. */
  publicUrl: URL | undefined;
  /** Set exactly when `authMode` is `oauth`. */
  oauth: OAuthConfig | undefined;
  dashboardClient: { id: string; secret: string } | undefined;
  sessionSecret: string;
  linkSecret: string;
  allowedHosts: string[] | undefined;
  allowedOrigins: string[];
  seedDemo: boolean;
  extractor: 'claude' | 'rules';
  anthropicApiKey: string | undefined;
  embeddings: 'voyage' | 'local';
  voyageApiKey: string | undefined;
  storage: { kind: 'local'; dir: string } | ({ kind: 'r2' } & R2Config);
  filing: { threshold: number; margin: number };
};

/** The MCP endpoint's URL: the OAuth protected resource identifier. */
export function mcpResourceUrl(publicUrl: URL): URL {
  return new URL('/mcp', publicUrl);
}

/** The origin links point at: PUBLIC_URL, or localhost in development. */
export function baseUrl(config: Config): URL {
  return config.publicUrl ?? new URL(`http://localhost:${config.port}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  const publicUrl = parsed.PUBLIC_URL ? new URL(parsed.PUBLIC_URL) : undefined;
  const production = parsed.NODE_ENV === 'production';

  let oauth: OAuthConfig | undefined;
  if (parsed.AUTH_MODE === 'oauth') {
    const missing = (['PUBLIC_URL', 'OAUTH_ISSUER'] as const).filter((key) => !parsed[key]);
    if (missing.length > 0) throw new Error(`AUTH_MODE=oauth requires ${missing.join(' and ')}.`);
    oauth = {
      issuer: parsed.OAUTH_ISSUER!,
      jwksUrl: parsed.OAUTH_JWKS_URL,
      audience: parsed.OAUTH_AUDIENCE ?? mcpResourceUrl(publicUrl!).href,
      emailClaim: parsed.OAUTH_EMAIL_CLAIM,
    };
  }

  if (production) {
    if (parsed.AUTH_MODE === 'dev') {
      throw new Error('AUTH_MODE=dev is not allowed in production. Configure OAuth first.');
    }
    if (publicUrl?.protocol !== 'https:') throw new Error('PUBLIC_URL must use https in production.');
    const missing = (['SESSION_SECRET', 'LINK_SECRET'] as const).filter((key) => !parsed[key]);
    if (missing.length > 0) throw new Error(`Production requires ${missing.join(' and ')} (32+ random characters).`);
  }

  if (parsed.EXTRACTOR === 'claude' && !parsed.ANTHROPIC_API_KEY) {
    throw new Error('EXTRACTOR=claude requires ANTHROPIC_API_KEY.');
  }
  if (parsed.EMBEDDINGS === 'voyage' && !parsed.VOYAGE_API_KEY) {
    throw new Error('EMBEDDINGS=voyage requires VOYAGE_API_KEY.');
  }

  let storage: Config['storage'] = { kind: 'local', dir: parsed.FILES_DIR };
  if (parsed.STORAGE === 'r2') {
    const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;
    const missing = keys.filter((key) => !parsed[key]);
    if (missing.length > 0) throw new Error(`STORAGE=r2 requires ${missing.join(', ')}.`);
    storage = {
      kind: 'r2',
      accountId: parsed.R2_ACCOUNT_ID!,
      accessKeyId: parsed.R2_ACCESS_KEY_ID!,
      secretAccessKey: parsed.R2_SECRET_ACCESS_KEY!,
      bucket: parsed.R2_BUCKET!,
    };
  }

  // Behind ngrok or a host, the Host header is the public host name: answer to it by default.
  const allowedHosts =
    list(parsed.ALLOWED_HOSTS) ?? (publicUrl ? [publicUrl.hostname, 'localhost', '127.0.0.1'] : undefined);

  // Outside production a missing secret gets a random one: links and sessions then last until the next restart.
  const randomSecret = () => randomBytes(32).toString('base64url');

  return {
    env: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    authMode: parsed.AUTH_MODE,
    devUser: parsed.DEV_USER,
    publicUrl,
    oauth,
    dashboardClient:
      parsed.DASHBOARD_CLIENT_ID && parsed.DASHBOARD_CLIENT_SECRET
        ? { id: parsed.DASHBOARD_CLIENT_ID, secret: parsed.DASHBOARD_CLIENT_SECRET }
        : undefined,
    sessionSecret: parsed.SESSION_SECRET ?? randomSecret(),
    linkSecret: parsed.LINK_SECRET ?? randomSecret(),
    allowedHosts,
    allowedOrigins: [...(list(parsed.ALLOWED_ORIGINS) ?? []), ...(publicUrl ? [publicUrl.origin] : [])],
    seedDemo: parsed.SEED_DEMO,
    extractor: parsed.EXTRACTOR === 'auto' ? (parsed.ANTHROPIC_API_KEY ? 'claude' : 'rules') : parsed.EXTRACTOR,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    embeddings: parsed.EMBEDDINGS === 'auto' ? (parsed.VOYAGE_API_KEY ? 'voyage' : 'local') : parsed.EMBEDDINGS,
    voyageApiKey: parsed.VOYAGE_API_KEY,
    storage,
    filing: { threshold: parsed.FILE_THRESHOLD, margin: parsed.FILE_MARGIN },
  };
}
