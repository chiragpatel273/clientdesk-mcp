import { canAccessClient, partitionByAccess } from '../domain/access.js';
import type { DocumentRecord } from '../domain/documents.js';
import type { MatchResult } from '../domain/matching.js';
import type { ToolContext } from './run-tool.js';

/** A candidate this likely is treated as "the document's client" for access purposes. */
export const LIKELY_OWNER = 0.5;

/**
 * May this staff member see a document's contents?
 * - Filed: only if they can access its client.
 * - Inbox or review: the inbox is the firm's shared intake tray, so yes, unless the document most likely belongs
 *   to a client they aren't assigned to. Then they can see that it exists and send it to review, nothing more.
 */
export async function canSeeDocument(
  ctx: Pick<ToolContext, 'db' | 'actor'>,
  doc: DocumentRecord,
  match: MatchResult | null,
): Promise<{ allowed: true } | { allowed: false; reason: string; detail: string }> {
  if (doc.status === 'filed') {
    if (doc.clientId && (await canAccessClient(ctx.db, ctx.actor, doc.clientId))) return { allowed: true };
    return {
      allowed: false,
      reason: 'This document is filed under a client you are not assigned to. Ask a partner for access.',
      detail: `filed under ${doc.clientId}`,
    };
  }
  const owner = match?.candidates[0];
  if (owner && owner.confidence >= LIKELY_OWNER && !(await canAccessClient(ctx.db, ctx.actor, owner.clientId))) {
    return {
      allowed: false,
      reason:
        'This document appears to belong to a client you are not assigned to, so its contents are withheld. ' +
        'Send it to review so a partner can file it.',
      detail: `likely owner ${owner.clientId} (${owner.confidence})`,
    };
  }
  return { allowed: true };
}

/**
 * The matcher's reasons may name any client. Before showing one to the caller, replace the names of candidates
 * they aren't assigned to.
 */
export async function redactHiddenClients(
  ctx: Pick<ToolContext, 'db' | 'actor'>,
  text: string,
  candidates: { clientId: string; name: string }[],
): Promise<string> {
  const { denied } = await partitionByAccess(
    ctx.db,
    ctx.actor,
    candidates.map((c) => c.clientId),
  );
  return candidates
    .filter((c) => denied.has(c.clientId))
    .reduce((out, c) => out.replaceAll(c.name, 'a client you are not assigned to'), text);
}
