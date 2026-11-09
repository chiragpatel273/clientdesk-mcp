import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seedDemoDocuments } from '../src/demo/documents.js';
import { isSeeded, resetData, seedDemoFirm } from '../src/demo/seed.js';
import { createServices } from '../src/services.js';

const reset = process.argv.includes('--reset');
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
  if (await isSeeded(db)) {
    console.log('Demo data already present. Use `npm run seed -- --reset` to reload it.');
  } else {
    await seedDemoFirm(db);
    const docs = await seedDemoDocuments(db, services);
    console.log(
      `Seeded Northbridge Advisory: 3 staff, 12 clients, ${docs} documents (embeddings: ${services.embedder.model}).`,
    );
  }
} finally {
  await db.close();
}
