/**
 * `npm run reindex`: rebuilds search passages with the configured embedder. Start-up already rebuilds stale ones
 * (another embedder, older format); `--all` rebuilds every document, e.g. after editing passage text by hand.
 */
import { loadConfig, loadDotEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { reindexStale } from '../src/domain/documents.js';
import { createServices } from '../src/services.js';

loadDotEnv();
const config = loadConfig();
const { embedder } = createServices(config);
const db = await createDb(config.databaseUrl);
try {
  await migrate(db);
  for (const { id } of await db.query<{ id: string }>('select id from firms order by id')) {
    const n = await reindexStale(db.forFirm(id), embedder, {
      all: process.argv.includes('--all'),
      log: console.log,
      onFailure: () => (process.exitCode = 1),
    });
    console.log(`${id}: rebuilt passages for ${n} documents with ${embedder.model}.`);
  }
} finally {
  await db.close();
}
