import { z } from 'zod';
import { canAccessClient, partitionByAccess } from '../domain/access.js';
import { findClients, type ClientRef } from '../domain/clients.js';
import type { ToolContext } from './run-tool.js';

export const ClientRefSchema = z.object({ id: z.string(), name: z.string() });

/** What a tool returns when the client couldn't be resolved to exactly one client the caller may see. */
export interface ClientRefusal {
  outcome: 'ok' | 'denied';
  text: string;
  structured: { status: 'not_found' | 'ambiguous' | 'denied'; message: string; candidates?: ClientRef[] };
  detail?: string;
}

/**
 * Resolves a client id or name for the signed-in staff member, exactly like `get_client`:
 * no match → not_found; several visible → ambiguous with candidates (never guess); none visible → denied.
 */
export async function resolveClient(
  ctx: ToolContext,
  query: string,
): Promise<{ client: ClientRef } | { refusal: ClientRefusal }> {
  const matches = await findClients(ctx.db, query);
  if (matches.length === 0) {
    const message = `No client matches "${query}".`;
    return { refusal: { outcome: 'ok', text: message, structured: { status: 'not_found', message } } };
  }
  const { allowed, denied } = await partitionByAccess(
    ctx.db,
    ctx.actor,
    matches.map((m) => m.id),
  );
  const visible = matches.filter((m) => allowed.has(m.id));
  if (visible.length === 0) {
    const message = `You are not assigned to ${matches.map((m) => m.name).join(', ')}. Ask a partner for access.`;
    return {
      refusal: {
        outcome: 'denied',
        text: message,
        structured: { status: 'denied', message },
        detail: `denied client ids: ${[...denied].join(', ')}`,
      },
    };
  }
  if (visible.length > 1) {
    const message = `${visible.length} clients match "${query}". Ask the user which one they mean.`;
    return {
      refusal: {
        outcome: 'ok',
        text: `${message}\n${visible.map((v) => `- ${v.name} (${v.id})`).join('\n')}`,
        structured: { status: 'ambiguous', message, candidates: visible },
      },
    };
  }
  return { client: visible[0]! };
}

/** For write tools that take a client id: re-checks access even if the id came from an earlier tool result. */
export async function requireClientAccess(ctx: ToolContext, clientId: string): Promise<boolean> {
  return canAccessClient(ctx.db, ctx.actor, clientId);
}
