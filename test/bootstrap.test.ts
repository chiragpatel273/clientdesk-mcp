import { describe, expect, it } from 'vitest';
import { seedDemo } from '../src/bootstrap.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { DEMO_DOCUMENTS } from '../src/demo/documents.js';
import { HL_DOCUMENTS } from '../src/demo/second-firm.js';
import { testServices } from './helpers.js';

describe('demo seeding on start-up', () => {
  it('finishes loading documents after a first start that failed on file storage', async () => {
    const db = await createDb('pglite://memory');
    await migrate(db);
    const count = async () =>
      Number(
        (
          await db.query<{ n: number }>(`select count(*)::int as n from documents where firm_id = 'firm_northbridge'`)
        )[0]?.n,
      );

    // First start: storage is misconfigured, so the firm loads and the first document fails.
    const broken = testServices({
      files: {
        put: async () => {
          throw new Error('S3 upload failed (400)');
        },
        get: async () => null,
      },
    });
    await expect(seedDemo(db, () => {}, broken)).rejects.toThrow('S3 upload failed');
    expect(await count()).toBe(0);

    // Next start, storage fixed: the documents are loaded, not skipped because the firm exists.
    const logs: string[] = [];
    await seedDemo(db, (m) => logs.push(m), testServices());
    expect(await count()).toBe(DEMO_DOCUMENTS.length);
    // The first start stopped at Northbridge's first document, before the second firm: both finish now.
    expect(logs).toEqual([
      `Loaded ${DEMO_DOCUMENTS.length} Northbridge Advisory demo documents.`,
      'Seeded the Harbourline Tax Partners demo firm.',
      `Loaded ${HL_DOCUMENTS.length} Harbourline Tax Partners demo documents.`,
    ]);

    // Later starts do nothing.
    logs.length = 0;
    await seedDemo(db, (m) => logs.push(m), testServices());
    expect(logs).toEqual([]);
  }, 60_000); // renders the 13 demo PDFs; slow when the suite runs in parallel
});
