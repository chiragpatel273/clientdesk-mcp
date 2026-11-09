import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { partitionByAccess } from '../../domain/access.js';
import { getDocument } from '../../domain/documents.js';
import { computeMatch, ensureExtraction } from '../../domain/intake.js';
import { canSeeDocument, redactHiddenClients } from '../document-access.js';
import { runTool, type ToolContext } from '../run-tool.js';

export const MatchClientOutput = {
  status: z.enum(['matched', 'needs_review', 'already_filed', 'not_found', 'denied']),
  message: z.string(),
  recommendation: z.enum(['file', 'review']).optional(),
  candidates: z
    .array(z.object({ clientId: z.string(), name: z.string(), confidence: z.number(), reasons: z.array(z.string()) }))
    .optional(),
  hiddenCandidates: z.number().optional(),
  threshold: z.number().optional(),
};
type Output = z.infer<z.ZodObject<typeof MatchClientOutput>>;

export function registerMatchClient(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'match_client',
    {
      title: 'Match document to client',
      description:
        'Work out which client an inbox document belongs to. Returns candidate clients with a confidence and the ' +
        'reasons, and a recommendation: "file" (one clear match: show it to the user and ask them to confirm, then ' +
        'call file_document) or "review" (unclear: explain why and call send_to_review). Never pick a client yourself ' +
        'when the recommendation is review.',
      inputSchema: {
        documentId: z.string().min(1).max(100).describe('Document id, e.g. from list_inbox'),
      },
      outputSchema: MatchClientOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool<Output>(ctx, 'match_client', input, async () => {
        const doc = await getDocument(ctx.db, input.documentId);
        if (!doc) {
          const message = `No document with id ${input.documentId}.`;
          return { outcome: 'ok', text: message, structured: { status: 'not_found', message } };
        }
        if (doc.status === 'filed') {
          const access = await canSeeDocument(ctx, doc, null);
          const message = access.allowed
            ? `${doc.title} is already filed under ${doc.clientName}.`
            : 'This document is already filed under a client you are not assigned to.';
          return {
            outcome: access.allowed ? 'ok' : 'denied',
            text: message,
            structured: { status: access.allowed ? 'already_filed' : 'denied', message },
          };
        }

        const extraction = await ensureExtraction(ctx.db, ctx.services, doc);
        const match = await computeMatch(ctx.db, ctx.services, doc, extraction);
        const access = await canSeeDocument(ctx, doc, match);
        if (!access.allowed) {
          return {
            outcome: 'denied',
            text: access.reason,
            structured: { status: 'denied', message: access.reason, recommendation: 'review' },
            detail: access.detail,
          };
        }

        const { allowed } = await partitionByAccess(
          ctx.db,
          ctx.actor,
          match.candidates.map((c) => c.clientId),
        );
        const visible = match.candidates.filter((c) => allowed.has(c.clientId));
        const hidden = match.candidates.length - visible.length;
        const recommendation = match.decision;
        const best = visible[0];
        const message =
          recommendation === 'file' && best
            ? `Best match: ${best.name} (${Math.round(best.confidence * 100)}%). Ask the user to confirm before filing.`
            : `Needs review: ${await redactHiddenClients(ctx, match.reason, match.candidates)}`;
        const lines = visible.map(
          (c) => `- ${c.name} (${c.clientId}): ${Math.round(c.confidence * 100)}%. ${c.reasons.join('; ')}`,
        );
        if (hidden) lines.push(`- ${hidden} other candidate(s) you are not assigned to.`);
        return {
          outcome: 'ok',
          text: [message, ...lines].join('\n'),
          structured: {
            status: recommendation === 'file' ? 'matched' : 'needs_review',
            message,
            recommendation,
            candidates: visible,
            hiddenCandidates: hidden,
            threshold: ctx.services.filing.threshold,
          },
          detail: `${recommendation}: ${match.reason}`,
        };
      }),
  );
}
