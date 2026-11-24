import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Db } from '../db/index.js';
import { errorCategory, usageScope } from '../ai/usage.js';
import { recordAudit } from '../domain/audit.js';
import type { Actor } from '../domain/types.js';
import type { AppServices } from '../services.js';

export interface ToolContext {
  db: Db;
  actor: Actor;
  services: AppServices;
}

export interface ToolResult<T extends Record<string, unknown>> {
  /** `denied` when the access check refused the request; it is logged as such. */
  outcome: 'ok' | 'denied';
  /** Short summary the model reads. */
  text: string;
  /** Machine-readable result, validated against the tool's outputSchema. */
  structured: T;
  /** Optional note stored in the audit log (never shown to the model). */
  detail?: string;
  /** The tool already wrote its audit row, in the same statement as its change. */
  audited?: boolean;
}

/** The document a tool call is about, when it names one: model calls it makes are recorded against it. */
function documentIdOf(input: unknown): string | null {
  const id = (input as { documentId?: unknown } | null)?.documentId;
  return typeof id === 'string' ? id : null;
}

export interface RunToolOptions {
  /** The tool changes data (its annotation says `readOnlyHint: false`). Read-only actors are refused before it runs. */
  writes?: boolean;
  /** A read tool that may call a model and caches the result: refused to read-only (public demo) actors as well. */
  costly?: boolean;
}

export const READ_ONLY_MESSAGE =
  'This is a read-only demo session, so nothing can be changed. Every attempt is logged.';

/**
 * Every tool handler runs through here, so no tool can skip the audit log.
 * Errors are logged and returned as a generic message; internals never reach the model.
 */
export async function runTool<T extends Record<string, unknown>>(
  ctx: ToolContext,
  tool: string,
  input: unknown,
  handler: () => Promise<ToolResult<T>>,
  options: RunToolOptions = {},
): Promise<CallToolResult> {
  const started = performance.now();
  try {
    // Checked here, not in each tool, so a new write tool can't forget it.
    const result: ToolResult<Record<string, unknown>> =
      (options.writes || options.costly) && ctx.actor.readOnly
        ? {
            outcome: 'denied',
            text: READ_ONLY_MESSAGE,
            structured: { status: 'denied', message: READ_ONLY_MESSAGE },
            detail: 'read-only session',
          }
        : await usageScope(
            {
              db: ctx.db,
              staffId: ctx.actor.staffId,
              source: 'mcp',
              documentId: documentIdOf(input),
            },
            handler,
          );
    if (!result.audited) {
      await recordAudit(ctx.db, {
        staffId: ctx.actor.staffId,
        tool,
        input,
        outcome: result.outcome,
        detail: result.detail,
        durationMs: performance.now() - started,
      });
    }
    return {
      content: [{ type: 'text', text: result.text }],
      structuredContent: result.structured,
    };
  } catch (error) {
    await recordAudit(ctx.db, {
      staffId: ctx.actor.staffId,
      tool,
      input,
      outcome: 'error',
      detail: errorCategory(error),
      durationMs: performance.now() - started,
    }).catch(() => undefined);
    return {
      isError: true,
      content: [{ type: 'text', text: `ClientDesk could not complete ${tool}. The error has been logged.` }],
    };
  }
}
