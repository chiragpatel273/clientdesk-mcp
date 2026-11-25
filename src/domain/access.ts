import { firmOf, type Db } from '../db/index.js';
import type { Actor } from './types.js';

/**
 * The single place that decides who may see a client.
 * Partners see every client of their firm; assistants see only clients assigned to them.
 * Tools must call this before reading or changing client data. It is never left to the model.
 * `db` must be scoped to the actor's firm; a client of another firm is never accessible, whatever the role.
 */
export async function canAccessClient(db: Db, actor: Actor, clientId: string): Promise<boolean> {
  const firmId = firmOf(db);
  if (firmId !== actor.firmId) return false;
  const rows =
    actor.role === 'partner'
      ? await db.query('select 1 from clients where id = $1 and firm_id = $2', [clientId, firmId])
      : await db.query('select 1 from client_assignments where client_id = $1 and staff_id = $2 and firm_id = $3', [
          clientId,
          actor.staffId,
          firmId,
        ]);
  return rows.length > 0;
}

/**
 * Every client id the actor may see, for queries that span clients (search, dashboard lists).
 * `all` for partners, meaning every client of the firm: queries using it must also filter by `firmOf(db)`.
 * Filter with `client_id = any($n)` using this list; never with a model-supplied id.
 */
export async function accessibleClientIds(db: Db, actor: Actor): Promise<string[] | 'all'> {
  const firmId = firmOf(db);
  if (firmId !== actor.firmId) return [];
  if (actor.role === 'partner') return 'all';
  const rows = await db.query<{ client_id: string }>(
    'select client_id from client_assignments where staff_id = $1 and firm_id = $2',
    [actor.staffId, firmId],
  );
  return rows.map((r) => r.client_id);
}

/** Splits client ids into those the actor may and may not see, in one query. */
export async function partitionByAccess(
  db: Db,
  actor: Actor,
  clientIds: string[],
): Promise<{ allowed: Set<string>; denied: Set<string> }> {
  const firmId = firmOf(db);
  if (clientIds.length === 0) return { allowed: new Set(), denied: new Set() };
  const rows =
    firmId !== actor.firmId
      ? []
      : actor.role === 'partner'
        ? await db.query<{ client_id: string }>(
            'select id as client_id from clients where firm_id = $1 and id = any($2::text[])',
            [firmId, clientIds],
          )
        : await db.query<{ client_id: string }>(
            'select client_id from client_assignments where staff_id = $1 and client_id = any($2::text[]) and firm_id = $3',
            [actor.staffId, clientIds, firmId],
          );
  const allowed = new Set(rows.map((r) => r.client_id));
  const denied = new Set(clientIds.filter((id) => !allowed.has(id)));
  return { allowed, denied };
}

/**
 * Records, for the owner of the deployment only, an attempt to use an id of another firm. Deliberately returns nothing: the
 * app can't tell another firm's id from one that doesn't exist.
 */
export async function noteCrossFirm(
  db: Db,
  actor: Pick<Actor, 'staffId'>,
  tool: string,
  kind: 'client' | 'document' | 'job' | 'batch' | 'open_item',
  id: string,
): Promise<void> {
  await db.query('select clientdesk_note_cross_firm($1, $2, $3, $4)', [kind, id.slice(0, 100), actor.staffId, tool]);
}
