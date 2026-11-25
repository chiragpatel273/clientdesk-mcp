import { seedDemo } from '../src/bootstrap.js';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { resetData } from '../src/demo/seed.js';
import { createServices } from '../src/services.js';

const reset = process.argv.includes('--reset');
loadDotEnv();
const config = loadConfig();
const services = createServices(config);
const db = await createDb(config.databaseUrl);
try {
  const ran = await migrate(db);
  if (ran.length) console.log(`Applied migrations: ${ran.join(', ')}`);
  if (reset) {
    await resetData(db);
    console.log('Cleared existing data.');
  }
  // Loads whichever demo firms (Northbridge, Harbourline) or documents are missing; does nothing when all are there.
  await seedDemo(db, console.log, services);
  console.log(`Demo data ready (embeddings: ${services.embedder.model}). Use --reset to reload it from scratch.`);
} finally {
  await db.close();
}
