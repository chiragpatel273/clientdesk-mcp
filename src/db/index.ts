import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import pg from 'pg';

/**
 * The one database interface the app uses. Two implementations:
 * PGlite (Postgres compiled to WASM) for tests and local development, and `pg` for production.
 * Both speak real Postgres SQL, so queries never branch on the driver.
 */
export interface Db {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function createDb(url: string): Promise<Db> {
  if (url.startsWith('pglite://')) {
    const location = url.slice('pglite://'.length);
    if (location !== 'memory') mkdirSync(location, { recursive: true });
    const client =
      location === 'memory' ? new PGlite({ extensions: { vector } }) : new PGlite(location, { extensions: { vector } });
    await client.waitReady;
    return {
      async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
        const result = await client.query<T>(sql, params);
        return result.rows;
      },
      async exec(sql: string) {
        await client.exec(sql);
      },
      async close() {
        await client.close();
      },
    };
  }

  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    return {
      async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
        const result = await pool.query<T>(sql, params);
        return result.rows;
      },
      async exec(sql: string) {
        await pool.query(sql);
      },
      async close() {
        await pool.end();
      },
    };
  }

  throw new Error(`Unsupported DATABASE_URL: ${url.split(':')[0]}://…`);
}
