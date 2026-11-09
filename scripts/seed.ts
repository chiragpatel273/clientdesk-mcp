import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { isSeeded, resetData, seedDemoFirm } from '../src/demo/seed.js';

const reset = process.argv.includes('--reset');
const config = loadConfig();
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
    console.log('Seeded Northbridge Advisory: 3 staff, 12 clients.');
  }
} finally {
  await db.close();
}
