import type { Config } from './config.js';
import { createDb, type Db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seedDemoDocuments } from './demo/documents.js';
import { isSeeded, seedDemoFirm } from './demo/seed.js';
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
  if (config.seedDemo && !(await isSeeded(db))) {
    await seedDemoFirm(db);
    const docs = await seedDemoDocuments(db, services);
    log(`Seeded the Northbridge Advisory demo firm (${docs} documents).`);
  }
  return db;
}
