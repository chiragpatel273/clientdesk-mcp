import { canAccessClient, noteCrossFirm, partitionByAccess } from '../domain/access.js';
import type { DocumentRecord } from '../domain/documents.js';
import type { MatchResult } from '../domain/matching.js';
import type { ToolContext } from './run-tool.js';

export const STILL_PROCESSING =
  'Batch intake is still processing this document; it will be filed or sent to review automatically.';

/** A candidate this likely is treated as "the document's client" for access purposes. */
export const LIKELY_OWNER = 0.5;

/**
 * May this staff member see a document's contents?
 * - Filed: only if they can access its client.
 * - Inbox or review: the inbox is the firm's shared intake tray, so yes, unless the document most likely belongs
 *   to a client they aren't assigned to. Then they can see that it exists and send it to review, nothing more.
 * - Being processed by batch intake: nobody, until the job is done with it. Not read yet: partners only (its owner is
 *   unknown).
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
  if (doc.status === 'processing') {
    return { allowed: false, reason: STILL_PROCESSING, detail: 'still processing' };
  }
  if (!doc.textRead && ctx.actor.role !== 'partner') {
    return {
      allowed: false,
      reason: 'This document could not be read, so nobody knows whose it is. Ask a partner.',
      detail: 'text not read',
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

/** Ids of ours, as opposed to names people type: cl_acme, doc_1f3a…, bat_… */
const LOOKS_LIKE_ID = /^[a-z]{2,4}_[a-z0-9_]+$/i;

/**
 * The audit outcome for something that wasn't found. Every unknown id is logged the same way (`denied`, "unknown id"),
 * whether it exists in another firm or nowhere, so nobody can tell the two apart, not even from their own audit log. If it
 * does belong to another firm, the attempt is also recorded for the owner of the deployment (`security_events`).
 */
export async function notFoundAudit(
  ctx: Pick<ToolContext, 'db' | 'actor'>,
  tool: string,
  kind: 'client' | 'document',
  id: string,
): Promise<{ outcome: 'ok' | 'denied'; detail?: string }> {
  if (kind === 'client' && !LOOKS_LIKE_ID.test(id)) return { outcome: 'ok' };
  await noteCrossFirm(ctx.db, ctx.actor, tool, kind, id);
  return { outcome: 'denied', detail: 'unknown id' };
}
