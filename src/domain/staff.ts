import type { Db } from '../db/index.js';
import type { Actor, Role } from './types.js';

type StaffRow = { id: string; name: string; email: string; role: Role; read_only: boolean };

const toActor = (row: StaffRow): Actor => ({
  staffId: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  readOnly: row.read_only,
});

export async function findActorByEmail(db: Db, email: string): Promise<Actor | null> {
  const [row] = await db.query<StaffRow>(
    'select id, name, email, role, read_only from staff where lower(email) = lower($1)',
    [email],
  );
  return row ? toActor(row) : null;
}

export async function findActorById(db: Db, staffId: string): Promise<Actor | null> {
  const [row] = await db.query<StaffRow>('select id, name, email, role, read_only from staff where id = $1', [staffId]);
  return row ? toActor(row) : null;
}
