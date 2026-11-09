import type { Db } from '../db/index.js';
import { CLIENTS, CONTACTS, NOTES, OPEN_ITEMS, STAFF } from './firm.js';

export async function isSeeded(db: Db): Promise<boolean> {
  const rows = await db.query<{ n: number }>('select count(*)::int as n from staff');
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Loads the fictional firm. Deterministic ids, so tests and the demo script can rely on them. */
export async function seedDemoFirm(db: Db): Promise<void> {
  for (const s of STAFF) {
    await db.query('insert into staff (id, name, email, role) values ($1, $2, $3, $4)', [
      s.id,
      s.name,
      s.email,
      s.role,
    ]);
  }
  for (const c of CLIENTS) {
    await db.query(
      'insert into clients (id, name, entity_type, fiscal_year_end, tax_id_last4) values ($1, $2, $3, $4, $5)',
      [c.id, c.name, c.entityType, c.fiscalYearEnd, c.taxIdLast4],
    );
    for (const staffId of c.team) {
      await db.query('insert into client_assignments (client_id, staff_id) values ($1, $2)', [c.id, staffId]);
    }
  }
  let i = 0;
  for (const c of CONTACTS) {
    await db.query(
      'insert into contacts (id, client_id, name, email, phone, is_primary) values ($1, $2, $3, $4, $5, $6)',
      [`ct_${String(++i).padStart(3, '0')}`, c.clientId, c.name, c.email, c.phone, c.isPrimary],
    );
  }
  i = 0;
  for (const o of OPEN_ITEMS) {
    await db.query(
      'insert into open_items (id, client_id, tax_year, description, status, due_date) values ($1, $2, $3, $4, $5, $6)',
      [`oi_${String(++i).padStart(3, '0')}`, o.clientId, o.taxYear, o.description, o.status, o.dueDate],
    );
  }
  i = 0;
  for (const n of NOTES) {
    await db.query('insert into notes (id, client_id, author_id, body, created_at) values ($1, $2, $3, $4, $5)', [
      `nt_${String(++i).padStart(3, '0')}`,
      n.clientId,
      n.authorId,
      n.body,
      n.createdAt,
    ]);
  }
}

/** Empties every table (keeps the schema). Used by `npm run seed -- --reset`. */
export async function resetData(db: Db): Promise<void> {
  await db.exec(
    'truncate audit_log, document_chunks, documents, notes, open_items, contacts, client_assignments, clients, staff restart identity cascade',
  );
}
