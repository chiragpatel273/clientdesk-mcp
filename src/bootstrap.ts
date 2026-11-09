import type { Config } from './config.js';
import { createDb, type Db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { isSeeded, seedDemoFirm } from './demo/seed.js';

/** Opens the database, applies migrations and (optionally) loads the demo firm. */
export async function openDatabase(config: Config, log: (msg: string) => void): Promise<Db> {
  const db = await createDb(config.databaseUrl);
  const ran = await migrate(db);
  if (ran.length) log(`Applied migrations: ${ran.join(', ')}`);
  if (config.seedDemo && !(await isSeeded(db))) {
    await seedDemoFirm(db);
    log('Seeded the Northbridge Advisory demo firm.');
  }
  return db;
}
