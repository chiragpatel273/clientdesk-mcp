import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import pg from 'pg';

/**
 * The one database interface the app uses. Two implementations:
 * PGlite (Postgres compiled to WASM) for tests and local development, and `pg` for production.
 * Both speak real Postgres SQL, so queries never branch on the driver.
 *
 * Multi-firm isolation: `forFirm(firmId)` returns a handle on which every query runs in its own transaction as the
 * role `clientdesk_app` with `app.firm_id` set, so Postgres row-level security limits it to that firm's rows.
 * Domain code takes the firm from the handle with `firmOf(db)` and filters on it too: two independent layers.
 * The unscoped (owner) handle is for migrations, identity lookup, the job queue and start-up only.
 */
export interface Db {
  /** Set on a firm-scoped handle. */
  readonly firmId?: string;
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** A handle limited to one firm (RLS + `firmOf`). On a scoped handle, only the same firm is allowed. */
  forFirm(firmId: string): Db;
  close(): Promise<void>;
}

export const APP_ROLE = 'clientdesk_app';
const FIRM_ID = /^firm_[a-z0-9_]{1,40}$/;

/** The firm a handle is scoped to. Throws on an unscoped handle: firm data is never read without a firm. */
export function firmOf(db: Db): string {
  if (!db.firmId) throw new Error('A firm-scoped database handle is required (db.forFirm(actor.firmId)).');
  return db.firmId;
}

function checkFirmId(firmId: string): void {
  if (!FIRM_ID.test(firmId)) throw new Error('Invalid firm id');
}

/** Runs one statement in a transaction as the app role with the firm set; `run` gets a single-connection executor. */
type Scoped = <T extends Record<string, unknown>>(firmId: string, sql: string, params: unknown[]) => Promise<T[]>;

function scopedHandle(firmId: string, run: Scoped): Db {
  checkFirmId(firmId);
  const handle: Db = {
    firmId,
    query: (sql, params = []) => run(firmId, sql, params),
    async exec() {
      throw new Error('exec is not available on a firm-scoped handle');
    },
    forFirm(other) {
      if (other !== firmId) throw new Error('A firm-scoped handle cannot switch firms');
      return handle;
    },
    async close() {
      // The root handle owns the connection.
    },
  };
  return handle;
}

export async function createDb(url: string): Promise<Db> {
  if (url.startsWith('pglite://')) {
    const location = url.slice('pglite://'.length);
    if (location !== 'memory') mkdirSync(location, { recursive: true });
    const client =
      location === 'memory' ? new PGlite({ extensions: { vector } }) : new PGlite(location, { extensions: { vector } });
    await client.waitReady;
    // PGlite serialises transactions, so concurrent requests can't see each other's firm setting.
    const run: Scoped = (firmId, sql, params) =>
      client.transaction(async (tx) => {
        await tx.exec(`set local role ${APP_ROLE}`);
        await tx.query(`select set_config('app.firm_id', $1, true)`, [firmId]);
        return (await tx.query(sql, params)).rows as never;
      });
    const root: Db = {
      async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
        const result = await client.query<T>(sql, params);
        return result.rows;
      },
      async exec(sql: string) {
        await client.exec(sql);
      },
      forFirm: (firmId) => scopedHandle(firmId, run),
      async close() {
        await client.close();
      },
    };
    return root;
  }

  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const run: Scoped = async (firmId, sql, params) => {
      const conn = await pool.connect();
      let broken = false;
      try {
        await conn.query(`begin; set local role ${APP_ROLE}`);
        await conn.query(`select set_config('app.firm_id', $1, true)`, [firmId]);
        const result = await conn.query(sql, params);
        await conn.query('commit');
        return result.rows;
      } catch (error) {
        await conn.query('rollback').catch(() => {
          broken = true;
        });
        throw error;
      } finally {
        // A connection whose rollback failed may still be inside the transaction: never reuse it.
        conn.release(broken ? true : undefined);
      }
    };
    const root: Db = {
      async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
        const result = await pool.query<T>(sql, params);
        return result.rows;
      },
      async exec(sql: string) {
        await pool.query(sql);
      },
      forFirm: (firmId) => scopedHandle(firmId, run),
      async close() {
        await pool.end();
      },
    };
    return root;
  }

  throw new Error(`Unsupported DATABASE_URL: ${url.split(':')[0]}://…`);
}
