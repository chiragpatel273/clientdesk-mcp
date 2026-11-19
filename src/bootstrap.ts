import type { Config } from './config.js';
import { createDb, type Db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { DEMO_DOCUMENTS, seedDemoDocuments } from './demo/documents.js';
import { ensureDemoVisitor, isSeeded, seedDemoFirm } from './demo/seed.js';
import type { AppServices } from './services.js';

/** Opens the database, applies migrations and (optionally) loads the demo firm and its documents. */
export async function openDatabase(
  config: Config,
  log: (msg: string) => void,
  services: Pick<AppServices, 'files' | 'embedder'>,
): Promise<Db> {
  const db = await createDb(config.databaseUrl);
  const ran = await migrate(db);
  if (ran.length) log(`Applied migrations: ${ran.join(', ')}`);
  if (config.seedDemo) await seedDemo(db, log, services);
  return db;
}

/**
 * Loads the demo firm when the database is empty, and its documents when any are missing. The second check makes an
 * interrupted first start (e.g. file storage misconfigured) finish on the next start instead of staying half-loaded;
 * documents already present are skipped by content hash.
 */
export async function seedDemo(
  db: Db,
  log: (msg: string) => void,
  services: Pick<AppServices, 'files' | 'embedder'>,
): Promise<void> {
  if (!(await isSeeded(db))) {
    await seedDemoFirm(db);
    log('Seeded the Northbridge Advisory demo firm.');
  } else if (await ensureDemoVisitor(db)) {
    log('Added the read-only demo visitor.');
  }
  const ids = DEMO_DOCUMENTS.map((d) => d.id);
  const [row] = await db.query<{ n: number }>('select count(*)::int as n from documents where id = any($1)', [ids]);
  if (Number(row?.n ?? 0) < ids.length) {
    const added = await seedDemoDocuments(db, services);
    log(`Loaded ${added} demo documents.`);
  }
}
