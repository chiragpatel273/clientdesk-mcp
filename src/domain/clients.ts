import type { Db } from '../db/index.js';

export interface ClientRef {
  id: string;
  name: string;
}

export interface ClientDetail {
  client: {
    id: string;
    name: string;
    entityType: string;
    fiscalYearEnd: string | null;
    status: string;
    assignedStaff: { name: string; role: string }[];
  };
  contacts: { name: string; email: string | null; phone: string | null; isPrimary: boolean }[];
  openItems: { id: string; taxYear: number; description: string; status: string; dueDate: string | null }[];
  recentNotes: { body: string; author: string | null; createdAt: string }[];
  recentDocuments: {
    id: string;
    title: string;
    docType: string | null;
    taxYear: number | null;
    status: string;
    receivedAt: string;
  }[];
}

/**
 * Finds clients matching an id or a name. Exact id or exact name wins outright;
 * otherwise every name containing the text is returned, so "Acme" can be ambiguous on purpose.
 */
export async function findClients(db: Db, query: string): Promise<ClientRef[]> {
  const q = query.trim();
  if (!q) return [];
  const exact = await db.query<{ id: string; name: string }>(
    'select id, name from clients where id = $1 or lower(name) = lower($1) order by name',
    [q],
  );
  if (exact.length > 0) return exact;
  return db.query<{ id: string; name: string }>(
    `select id, name from clients
     where lower(name) like '%' || lower($1) || '%'
     order by name limit 10`,
    [q],
  );
}

const TS = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export async function getClientDetail(db: Db, clientId: string): Promise<ClientDetail | null> {
  const [client] = await db.query<{
    id: string;
    name: string;
    entity_type: string;
    fiscal_year_end: string | null;
    status: string;
  }>('select id, name, entity_type, fiscal_year_end, status from clients where id = $1', [clientId]);
  if (!client) return null;

  const [staff, contacts, openItems, notes, documents] = await Promise.all([
    db.query<{ name: string; role: string }>(
      `select s.name, s.role from client_assignments a join staff s on s.id = a.staff_id
       where a.client_id = $1 order by s.role desc, s.name`,
      [clientId],
    ),
    db.query<{ name: string; email: string | null; phone: string | null; is_primary: boolean }>(
      'select name, email, phone, is_primary from contacts where client_id = $1 order by is_primary desc, name',
      [clientId],
    ),
    db.query<{ id: string; tax_year: number; description: string; status: string; due_date: string | null }>(
      `select id, tax_year, description, status, due_date::text as due_date from open_items
       where client_id = $1 order by tax_year desc, (status = 'open') desc, due_date nulls last`,
      [clientId],
    ),
    db.query<{ body: string; author: string | null; created_at: string }>(
      `select n.body, s.name as author, ${TS('n.created_at')} as created_at
       from notes n left join staff s on s.id = n.author_id
       where n.client_id = $1 order by n.created_at desc limit 5`,
      [clientId],
    ),
    db.query<{
      id: string;
      title: string;
      doc_type: string | null;
      tax_year: number | null;
      status: string;
      received_at: string;
    }>(
      `select id, title, doc_type, tax_year, status, ${TS('received_at')} as received_at
       from documents where client_id = $1 order by received_at desc limit 5`,
      [clientId],
    ),
  ]);

  return {
    client: {
      id: client.id,
      name: client.name,
      entityType: client.entity_type,
      fiscalYearEnd: client.fiscal_year_end,
      status: client.status,
      assignedStaff: staff,
    },
    contacts: contacts.map((c) => ({ name: c.name, email: c.email, phone: c.phone, isPrimary: c.is_primary })),
    openItems: openItems.map((o) => ({
      id: o.id,
      taxYear: Number(o.tax_year),
      description: o.description,
      status: o.status,
      dueDate: o.due_date,
    })),
    recentNotes: notes.map((n) => ({ body: n.body, author: n.author, createdAt: n.created_at })),
    recentDocuments: documents.map((d) => ({
      id: d.id,
      title: d.title,
      docType: d.doc_type,
      taxYear: d.tax_year === null ? null : Number(d.tax_year),
      status: d.status,
      receivedAt: d.received_at,
    })),
  };
}
