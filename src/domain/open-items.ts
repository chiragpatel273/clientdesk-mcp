import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';

export interface OpenItem {
  id: string;
  taxYear: number;
  description: string;
  status: string;
  dueDate: string | null;
  document: { id: string; title: string } | null;
}

export async function listOpenItems(
  db: Db,
  clientId: string,
  taxYear: number | undefined,
  status: 'open' | 'received' | 'waived' | 'all',
): Promise<OpenItem[]> {
  const rows = await db.query<{
    id: string;
    tax_year: number;
    description: string;
    status: string;
    due_date: string | null;
    document_id: string | null;
    document_title: string | null;
  }>(
    `select o.id, o.tax_year, o.description, o.status, o.due_date::text as due_date,
            o.document_id, d.title as document_title
     from open_items o left join documents d on d.id = o.document_id
     where o.client_id = $1 and ($2::int is null or o.tax_year = $2) and ($3::text = 'all' or o.status = $3)
     order by o.tax_year desc, (o.status = 'open') desc, o.due_date nulls last, o.id`,
    [clientId, taxYear ?? null, status],
  );
  return rows.map((r) => ({
    id: r.id,
    taxYear: Number(r.tax_year),
    description: r.description,
    status: r.status,
    dueDate: r.due_date,
    document: r.document_id ? { id: r.document_id, title: r.document_title ?? r.document_id } : null,
  }));
}

export async function addOpenItem(
  db: Db,
  input: { clientId: string; taxYear: number; description: string; dueDate: string | null },
): Promise<string> {
  const id = `oi_${randomBytes(5).toString('hex')}`;
  await db.query(
    'insert into open_items (id, client_id, tax_year, description, status, due_date) values ($1, $2, $3, $4, $5, $6)',
    [id, input.clientId, input.taxYear, input.description, 'open', input.dueDate],
  );
  return id;
}

/** Marks an open item received by a document, only if it belongs to that client and is still open. */
export async function closeOpenItem(
  db: Db,
  input: { id: string; clientId: string; documentId: string },
): Promise<{ id: string; description: string } | null> {
  const rows = await db.query<{ id: string; description: string }>(
    `update open_items set status = 'received', document_id = $3
     where id = $1 and client_id = $2 and status = 'open' returning id, description`,
    [input.id, input.clientId, input.documentId],
  );
  return rows[0] ?? null;
}

export async function addNote(
  db: Db,
  input: { clientId: string; authorId: string; body: string; kind?: 'note' | 'filing' },
): Promise<string> {
  const id = `nt_${randomBytes(5).toString('hex')}`;
  await db.query('insert into notes (id, client_id, author_id, body, kind) values ($1, $2, $3, $4, $5)', [
    id,
    input.clientId,
    input.authorId,
    input.body,
    input.kind ?? 'note',
  ]);
  return id;
}
