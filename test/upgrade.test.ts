import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedDemo } from '../src/bootstrap.js';
import { createDb } from '../src/db/index.js';
import { migrate, projectRoot } from '../src/db/migrate.js';
import { getDocument, PASSAGE_VERSION, reindexStale } from '../src/domain/documents.js';
import { CLIENTS, STAFF } from '../src/demo/firm.js';
import { testServices } from './helpers.js';

/**
 * The deploy path: a database created by v1 (migrations 001 and 002 only, with data in it) is upgraded by v2's
 * migrations on start, as it will be on Neon.
 */
describe('upgrading a v1 database', () => {
  it('backfills every row to Northbridge, turns on isolation, and finishes start-up', async () => {
    const db = await createDb('pglite://memory');
    await db.exec(
      'create table schema_migrations (version text primary key, applied_at timestamptz not null default now())',
    );
    for (const file of ['001_init.sql', '002_documents.sql']) {
      await db.exec(await readFile(join(projectRoot(), 'migrations', file), 'utf8'));
      await db.query('insert into schema_migrations (version) values ($1)', [file]);
    }
    // v1 data, as v1's seed wrote it (no firm column): the firm's staff and clients, plus a filed document with an
    // old-format passage and an audit row.
    for (const st of STAFF) {
      await db.query('insert into staff (id, name, email, role) values ($1, $2, $3, $4)', [
        st.id,
        st.name,
        st.email,
        st.role,
      ]);
    }
    for (const c of CLIENTS) {
      await db.query('insert into clients (id, name, entity_type, tax_id_last4) values ($1, $2, $3, $4)', [
        c.id,
        c.name,
        c.entityType,
        c.taxIdLast4,
      ]);
      for (const staffId of c.team) {
        await db.query('insert into client_assignments (client_id, staff_id) values ($1, $2)', [c.id, staffId]);
      }
    }
    await db.exec(`
      insert into documents (id, client_id, title, status, page_text, content_sha256)
        values ('doc_v1', 'cl_acme', 'Invoice A-1 from Old Vendor', 'filed', '["INVOICE A-1\\nBill to: Acme Ltd\\nTotal due: $5.00"]', 'abc');
      insert into document_chunks (id, document_id, page, chunk_index, content, embedding_model)
        values ('doc_v1_c0', 'doc_v1', 1, 0, 'old passage', 'local-hash-v1');
      insert into audit_log (staff_id, tool, outcome) values ('st_maya', 'get_client', 'ok');
    `);

    const ran = await migrate(db);
    expect(ran).toEqual([
      '003_demo_visitor.sql',
      '004_passage_version.sql',
      '005_jobs.sql',
      '006_llm_calls.sql',
      '007_firms.sql',
    ]);
    for (const table of ['staff', 'clients', 'client_assignments', 'documents', 'document_chunks', 'audit_log']) {
      const rows = await db.query<{ firm_id: string }>(`select distinct firm_id from ${table}`);
      expect(rows, table).toEqual([{ firm_id: 'firm_northbridge' }]);
    }

    // Start-up on the upgraded database: the demo visitor and the second firm are added, v1's data stays as it was.
    const logs: string[] = [];
    await seedDemo(db, (m) => logs.push(m), testServices());
    expect(logs).toContain('Added the read-only demo visitor.');
    expect(logs).toContain('Seeded the Harbourline Tax Partners demo firm.');
    const nb = db.forFirm('firm_northbridge');
    expect((await getDocument(nb, 'doc_v1'))?.title).toBe('Invoice A-1 from Old Vendor');
    expect(await getDocument(db.forFirm('firm_harbourline'), 'doc_v1')).toBeNull(); // RLS + domain filter

    // The old-format passage is rebuilt in the new format.
    expect(await reindexStale(nb, testServices().embedder)).toBeGreaterThanOrEqual(1);
    const [chunk] = await db.query<{ v: number }>(
      `select min(passage_version)::int as v from document_chunks where document_id = 'doc_v1'`,
    );
    expect(chunk?.v).toBe(PASSAGE_VERSION);
    await db.close();
  }, 120_000);
});
