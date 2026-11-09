import type { Db } from '../db/index.js';
import type { Actor, Role } from './types.js';

export async function findActorByEmail(db: Db, email: string): Promise<Actor | null> {
  const rows = await db.query<{ id: string; name: string; email: string; role: Role }>(
    'select id, name, email, role from staff where lower(email) = lower($1)',
    [email],
  );
  const row = rows[0];
  return row ? { staffId: row.id, name: row.name, email: row.email, role: row.role } : null;
}
