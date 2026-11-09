import type { Db } from '../db/index.js';
import type { Actor } from './types.js';

/**
 * The single place that decides who may see a client.
 * Partners see every client; assistants see only clients assigned to them.
 * Tools must call this before reading or changing client data. It is never left to the model.
 */
export async function canAccessClient(db: Db, actor: Actor, clientId: string): Promise<boolean> {
  if (actor.role === 'partner') return true;
  const rows = await db.query('select 1 from client_assignments where client_id = $1 and staff_id = $2', [
    clientId,
    actor.staffId,
  ]);
  return rows.length > 0;
}

/** Splits client ids into those the actor may and may not see, in one query. */
export async function partitionByAccess(
  db: Db,
  actor: Actor,
  clientIds: string[],
): Promise<{ allowed: Set<string>; denied: Set<string> }> {
  if (actor.role === 'partner' || clientIds.length === 0) {
    return { allowed: new Set(clientIds), denied: new Set() };
  }
  const rows = await db.query<{ client_id: string }>(
    'select client_id from client_assignments where staff_id = $1 and client_id = any($2::text[])',
    [actor.staffId, clientIds],
  );
  const allowed = new Set(rows.map((r) => r.client_id));
  const denied = new Set(clientIds.filter((id) => !allowed.has(id)));
  return { allowed, denied };
}
