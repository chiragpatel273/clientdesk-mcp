import type { Db } from '../db/index.js';
import type { Actor, Role } from './types.js';

type StaffRow = { id: string; firm_id: string; name: string; email: string; role: Role; read_only: boolean };

const toActor = (row: StaffRow): Actor => ({
  staffId: row.id,
  firmId: row.firm_id,
  name: row.name,
  email: row.email,
  role: row.role,
  readOnly: row.read_only,
});

/**
 * Identity lookup: who is this, and which firm are they in. Runs on the unscoped handle, before the firm is known
 * (an email is unique across firms). Everything after it runs on `db.forFirm(actor.firmId)`.
 */
export async function findActorByEmail(db: Db, email: string): Promise<Actor | null> {
  const [row] = await db.query<StaffRow>(
    'select id, firm_id, name, email, role, read_only from staff where lower(email) = lower($1)',
    [email],
  );
  return row ? toActor(row) : null;
}

/** Identity lookup by id (signed links, sessions): unscoped, like findActorByEmail. */
export async function findActorById(db: Db, staffId: string): Promise<Actor | null> {
  const [row] = await db.query<StaffRow>('select id, firm_id, name, email, role, read_only from staff where id = $1', [
    staffId,
  ]);
  return row ? toActor(row) : null;
}
