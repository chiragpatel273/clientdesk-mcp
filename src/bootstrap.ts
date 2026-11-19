import { usageScope } from './ai/usage.js';
import type { Config } from './config.js';
import { createDb, type Db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { DEMO_DOCUMENTS, seedDemoDocuments, seedSecondFirmDocuments } from './demo/documents.js';
import { HARBOURLINE, HL_DOCUMENTS } from './demo/second-firm.js';
import { reindexStale } from './domain/documents.js';
import { ensureDemoVisitor, ensureFirms, NORTHBRIDGE, seedDemoFirm, seedSecondFirm } from './demo/seed.js';
import type { AppServices } from './services.js';

/** Opens the database, applies migrations and (optionally) loads the demo firms and their documents. */
export async function openDatabase(
  config: Config,
  log: (msg: string) => void,
  services: Pick<AppServices, 'files' | 'embedder'>,
): Promise<Db> {
  const db = await createDb(config.databaseUrl);
  const ran = await migrate(db);
  if (ran.length) log(`Applied migrations: ${ran.join(', ')}`);
  if (config.seedDemo) await seedDemo(db, log, services);
  // Embedding demo documents and rebuilding passages are model calls too: recorded as start-up work, per firm.
  const firms = await db.query<{ id: string }>('select id from firms order by id');
  for (const { id } of firms) {
    const firmDb = db.forFirm(id);
    const reindexed = await usageScope({ db: firmDb, source: 'startup' }, () =>
      reindexStale(firmDb, services.embedder, { log }),
    );
    if (reindexed)
      log(`Rebuilt search passages for ${reindexed} ${id} documents (embeddings: ${services.embedder.model}).`);
  }
  return db;
}

/**
 * Loads each demo firm whose staff are missing, and its documents when any are missing. The document check makes an
 * interrupted first start (e.g. file storage misconfigured) finish on the next start instead of staying half-loaded;
 * documents already present are skipped by content hash. `db` is the unscoped handle; each firm loads on its own.
 */
export async function seedDemo(
  db: Db,
  log: (msg: string) => void,
  services: Pick<AppServices, 'files' | 'embedder'>,
): Promise<void> {
  await ensureFirms(db);
  const firms = [
    {
      firm: NORTHBRIDGE,
      seed: seedDemoFirm,
      documents: DEMO_DOCUMENTS.map((d) => d.id),
      seedDocuments: seedDemoDocuments,
    },
    {
      firm: HARBOURLINE,
      seed: seedSecondFirm,
      documents: HL_DOCUMENTS.map((d) => d.id),
      seedDocuments: seedSecondFirmDocuments,
    },
  ];
  for (const f of firms) {
    const firmDb = db.forFirm(f.firm.id);
    const [staff] = await firmDb.query<{ n: number }>('select count(*)::int as n from staff where firm_id = $1', [
      f.firm.id,
    ]);
    if (Number(staff?.n ?? 0) === 0) {
      await usageScope({ db: firmDb, source: 'startup' }, () => f.seed(firmDb));
      log(`Seeded the ${f.firm.name} demo firm.`);
    } else if (f.firm.id === NORTHBRIDGE.id && (await ensureDemoVisitor(firmDb))) {
      log('Added the read-only demo visitor.');
    }
    const [docs] = await firmDb.query<{ n: number }>(
      'select count(*)::int as n from documents where id = any($1) and firm_id = $2',
      [f.documents, f.firm.id],
    );
    if (Number(docs?.n ?? 0) < f.documents.length) {
      const added = await usageScope({ db: firmDb, source: 'startup' }, () => f.seedDocuments(firmDb, services));
      log(`Loaded ${added} ${f.firm.name} demo documents.`);
    }
  }
}
