import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * `pglite://memory` for tests, `pglite://<dir>` for local development,
   * or a normal `postgres://` URL (Neon) in production.
   */
  DATABASE_URL: z.string().default('pglite://.data/pglite'),
  /**
   * `dev` trusts an `x-clientdesk-user` header (or DEV_USER) to pick the signed-in staff member.
   * It exists only so the connector can be tried before OAuth lands (Day 3) and is refused in production.
   */
  AUTH_MODE: z.enum(['dev', 'oauth']).default('dev'),
  DEV_USER: z.string().email().default('maya@northbridge.example'),
  /** Comma-separated host names the HTTP server answers to (DNS-rebinding protection). */
  ALLOWED_HOSTS: z.string().optional(),
  /** Seed the fictional Northbridge Advisory data on start when the database is empty. */
  SEED_DEMO: z
    .enum(['0', '1'])
    .default('1')
    .transform((v) => v === '1'),
});

export type Config = {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  authMode: 'dev' | 'oauth';
  devUser: string;
  allowedHosts: string[] | undefined;
  seedDemo: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  const config: Config = {
    env: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    authMode: parsed.AUTH_MODE,
    devUser: parsed.DEV_USER,
    allowedHosts: parsed.ALLOWED_HOSTS?.split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    seedDemo: parsed.SEED_DEMO,
  };
  if (config.env === 'production' && config.authMode === 'dev') {
    throw new Error('AUTH_MODE=dev is not allowed in production. Configure OAuth first.');
  }
  return config;
}
