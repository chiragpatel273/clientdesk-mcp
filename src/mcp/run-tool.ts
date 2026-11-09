import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Db } from '../db/index.js';
import { recordAudit } from '../domain/audit.js';
import type { Actor } from '../domain/types.js';

export interface ToolContext {
  db: Db;
  actor: Actor;
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
}

/**
 * Every tool handler runs through here, so no tool can skip the audit log.
 * Errors are logged and returned as a generic message; internals never reach the model.
 */
export async function runTool<T extends Record<string, unknown>>(
  ctx: ToolContext,
  tool: string,
  input: unknown,
  handler: () => Promise<ToolResult<T>>,
): Promise<CallToolResult> {
  const started = performance.now();
  try {
    const result = await handler();
    await recordAudit(ctx.db, {
      staffId: ctx.actor.staffId,
      tool,
      input,
      outcome: result.outcome,
      detail: result.detail,
      durationMs: performance.now() - started,
    });
    return {
      content: [{ type: 'text', text: result.text }],
      structuredContent: result.structured,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordAudit(ctx.db, {
      staffId: ctx.actor.staffId,
      tool,
      input,
      outcome: 'error',
      detail: message.slice(0, 500),
      durationMs: performance.now() - started,
    }).catch(() => undefined);
    return {
      isError: true,
      content: [{ type: 'text', text: `ClientDesk could not complete ${tool}. The error has been logged.` }],
    };
  }
}
