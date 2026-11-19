import { firmOf, type Db } from '../db/index.js';
import { CLIENTS, CONTACTS, DEMO_VISITOR, NOTES, OPEN_ITEMS, STAFF } from './firm.js';
import { HARBOURLINE, HL_CLIENTS, HL_CONTACTS, HL_NOTES, HL_OPEN_ITEMS, HL_STAFF } from './second-firm.js';

export const NORTHBRIDGE = { id: 'firm_northbridge', name: 'Northbridge Advisory' } as const;
export const DEMO_FIRMS = [NORTHBRIDGE, HARBOURLINE] as const;

export async function isSeeded(db: Db): Promise<boolean> {
  const rows = await db.query<{ n: number }>('select count(*)::int as n from staff');
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Adds the demo firms (unscoped: the firms table is the one thing above firms). */
export async function ensureFirms(db: Db): Promise<void> {
  for (const f of DEMO_FIRMS) {
    await db.query('insert into firms (id, name) values ($1, $2) on conflict (id) do nothing', [f.id, f.name]);
  }
}

interface FirmData {
  staff: readonly { id: string; name: string; email: string; role: string }[];
  clients: readonly {
    id: string;
    name: string;
    entityType: string;
    fiscalYearEnd: string;
    taxIdLast4: string;
    team: readonly string[];
  }[];
  contacts: readonly { clientId: string; name: string; email: string; phone: string; isPrimary: boolean }[];
  openItems: readonly {
    clientId: string;
    taxYear: number;
    description: string;
    status: string;
    dueDate: string | null;
  }[];
  notes: readonly { clientId: string; authorId: string; body: string; createdAt: string }[];
  /** Prefix for generated ids (contacts, items, notes), unique per firm. */
  idPrefix: string;
}

/** Loads one firm's people and clients. `db` is scoped to that firm; ids are deterministic. */
async function seedFirmData(db: Db, data: FirmData): Promise<void> {
  const firmId = firmOf(db);
  for (const s of data.staff) {
    await db.query('insert into staff (id, name, email, role, firm_id) values ($1, $2, $3, $4, $5)', [
      s.id,
      s.name,
      s.email,
      s.role,
      firmId,
    ]);
  }
  for (const c of data.clients) {
    await db.query(
      'insert into clients (id, name, entity_type, fiscal_year_end, tax_id_last4, firm_id) values ($1, $2, $3, $4, $5, $6)',
      [c.id, c.name, c.entityType, c.fiscalYearEnd, c.taxIdLast4, firmId],
    );
    for (const staffId of c.team) {
      await db.query('insert into client_assignments (client_id, staff_id, firm_id) values ($1, $2, $3)', [
        c.id,
        staffId,
        firmId,
      ]);
    }
  }
  let i = 0;
  for (const c of data.contacts) {
    await db.query(
      'insert into contacts (id, client_id, name, email, phone, is_primary, firm_id) values ($1, $2, $3, $4, $5, $6, $7)',
      [`ct_${data.idPrefix}${String(++i).padStart(3, '0')}`, c.clientId, c.name, c.email, c.phone, c.isPrimary, firmId],
    );
  }
  i = 0;
  for (const o of data.openItems) {
    await db.query(
      `insert into open_items (id, client_id, tax_year, description, status, due_date, firm_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        `oi_${data.idPrefix}${String(++i).padStart(3, '0')}`,
        o.clientId,
        o.taxYear,
        o.description,
        o.status,
        o.dueDate,
        firmId,
      ],
    );
  }
  i = 0;
  for (const n of data.notes) {
    await db.query(
      'insert into notes (id, client_id, author_id, body, created_at, firm_id) values ($1, $2, $3, $4, $5, $6)',
      [`nt_${data.idPrefix}${String(++i).padStart(3, '0')}`, n.clientId, n.authorId, n.body, n.createdAt, firmId],
    );
  }
}

/** Loads the fictional Northbridge Advisory (and its read-only demo visitor). `db` is scoped to Northbridge. */
export async function seedDemoFirm(db: Db): Promise<void> {
  await seedFirmData(db, {
    staff: STAFF,
    clients: CLIENTS,
    contacts: CONTACTS,
    openItems: OPEN_ITEMS,
    notes: NOTES,
    idPrefix: '',
  });
  await ensureDemoVisitor(db);
}

/** Loads Harbourline Tax Partners, the second firm. `db` is scoped to Harbourline. */
export async function seedSecondFirm(db: Db): Promise<void> {
  await seedFirmData(db, {
    staff: HL_STAFF,
    clients: HL_CLIENTS,
    contacts: HL_CONTACTS,
    openItems: HL_OPEN_ITEMS,
    notes: HL_NOTES,
    idPrefix: 'hl_',
  });
}

/** Adds the read-only demo visitor if it's missing (databases seeded before v2 don't have it). Scoped to Northbridge. */
export async function ensureDemoVisitor(db: Db): Promise<boolean> {
  const rows = await db.query(
    `insert into staff (id, name, email, role, read_only, firm_id) values ($1, $2, $3, $4, true, $5)
     on conflict (id) do nothing returning id`,
    [DEMO_VISITOR.id, DEMO_VISITOR.name, DEMO_VISITOR.email, DEMO_VISITOR.role, firmOf(db)],
  );
  return rows.length > 0;
}

/** Empties every table except firms (keeps the schema). Used by `npm run seed -- --reset`. Unscoped. */
export async function resetData(db: Db): Promise<void> {
  await db.exec(
    `truncate llm_calls, jobs, batches, audit_log, document_chunks, documents, notes, open_items, contacts,
              client_assignments, clients, staff restart identity cascade`,
  );
}
