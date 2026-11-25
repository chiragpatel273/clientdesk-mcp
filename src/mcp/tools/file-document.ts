import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { inferTaxYear } from '../../ai/extraction.js';
import { canAccessClient, noteCrossFirm } from '../../domain/access.js';
import { recordAudit } from '../../domain/audit.js';
import { getDocument, markFiled, refreshPassages, titleForFiling } from '../../domain/documents.js';
import { computeMatch, ensureExtraction, ensureText } from '../../domain/intake.js';
import { closeOpenItem } from '../../domain/open-items.js';
import { notFoundAudit, redactHiddenClients, STILL_PROCESSING } from '../document-access.js';
import { runTool, type ToolContext } from '../run-tool.js';

export const FileDocumentOutput = {
  status: z.enum(['filed', 'refused', 'not_found', 'denied']),
  message: z.string(),
  document: z
    .object({
      id: z.string(),
      title: z.string(),
      clientId: z.string(),
      clientName: z.string(),
      taxYear: z.number().nullable(),
      docType: z.string().nullable(),
      link: z.string(),
    })
    .optional(),
  openItemClosed: z.object({ id: z.string(), description: z.string() }).nullable().optional(),
};
type Output = z.infer<z.ZodObject<typeof FileDocumentOutput>>;

export function registerFileDocument(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'file_document',
    {
      title: 'File document to client',
      description:
        'File an inbox document under a client. Only call this after match_client recommended it and the user confirmed ' +
        'the client. The server re-checks the match itself and refuses when the client is not the clear best match ' +
        'above the confidence threshold; then use send_to_review instead. Optionally closes the open item the ' +
        'document satisfies.',
      inputSchema: {
        documentId: z.string().min(1).max(100).describe('Inbox document id'),
        clientId: z.string().min(1).max(100).describe('Client id the user confirmed, e.g. cl_acme'),
        taxYear: z.number().int().min(2000).max(2100).optional().describe('Override the extracted tax year'),
        openItemId: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('Open item this document satisfies (from list_open_items)'),
      },
      outputSchema: FileDocumentOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool<Output>(
        ctx,
        'file_document',
        input,
        async () => {
          // Access first, from the id given now: never trust that an earlier tool call checked it.
          if (!(await canAccessClient(ctx.db, ctx.actor, input.clientId))) {
            await noteCrossFirm(ctx.db, ctx.actor, 'file_document', 'client', input.clientId);
            const message = 'You are not assigned to that client, so you cannot file documents for it.';
            return {
              outcome: 'denied',
              text: message,
              structured: { status: 'denied', message },
              detail: `client ${input.clientId}`,
            };
          }
          const found = await getDocument(ctx.db, input.documentId);
          if (!found) {
            const message = `No document with id ${input.documentId}.`;
            return {
              ...(await notFoundAudit(ctx, 'file_document', 'document', input.documentId)),
              text: message,
              structured: { status: 'not_found', message },
            };
          }
          if (found.status !== 'inbox') {
            const message =
              found.status === 'review'
                ? 'This document is in the review queue; a partner resolves it from the dashboard.'
                : found.status === 'processing'
                  ? STILL_PROCESSING
                  : 'This document is already filed.';
            return {
              outcome: 'ok',
              text: message,
              structured: { status: 'refused', message },
              detail: `status ${found.status}`,
            };
          }

          const doc = await ensureText(ctx.db, ctx.services, found);
          const extraction = await ensureExtraction(ctx.db, ctx.services, doc);
          const match = await computeMatch(ctx.db, ctx.services, doc, extraction);
          const best = match.candidates[0];
          if (match.decision !== 'file' || best?.clientId !== input.clientId) {
            const why =
              match.decision !== 'file'
                ? await redactHiddenClients(ctx, match.reason, match.candidates)
                : `the clear match is a different client, not ${input.clientId}`;
            const message = `Not filed: ${why} Send it to review instead.`;
            return {
              outcome: 'ok',
              text: message,
              structured: { status: 'refused', message },
              detail: `refused: ${why}`,
            };
          }

          const taxYear = input.taxYear ?? inferTaxYear(extraction);
          const docType = extraction.docType;
          const title = titleForFiling(doc, extraction);
          if (
            !(await markFiled(ctx.db, {
              id: doc.id,
              clientId: best.clientId,
              taxYear,
              docType,
              staffId: ctx.actor.staffId,
              title,
              audit: { tool: 'file_document', input, detail: `filed to ${best.clientId} at ${best.confidence}` },
            }))
          ) {
            const message = 'The document changed while filing (someone else may have processed it). Check the inbox.';
            return { outcome: 'ok', text: message, structured: { status: 'refused', message } };
          }
          await refreshPassages(ctx.db, ctx.services.embedder, doc.id);
          // Filed and audited: whatever happens to the open item can't undo that or be reported as a failed filing.
          const openItemClosed = input.openItemId
            ? await closeOpenItem(ctx.db, {
                id: input.openItemId,
                clientId: best.clientId,
                documentId: doc.id,
              }).catch(() => null)
            : null;
          if (input.openItemId && !openItemClosed) {
            // Logged on its own, so a made-up id doesn't hide behind an `ok`.
            await noteCrossFirm(ctx.db, ctx.actor, 'file_document', 'open_item', input.openItemId);
            await recordAudit(ctx.db, {
              staffId: ctx.actor.staffId,
              tool: 'file_document:open_item',
              input: { openItemId: input.openItemId },
              outcome: 'denied',
              detail: 'not closed: not an open item of this client, or it could not be changed',
              durationMs: 0,
            });
          }

          const link = ctx.services.links.url(doc.id, ctx.actor.staffId);
          const message =
            `Filed "${title}" under ${best.name} as ${docType}${taxYear ? ` for ${taxYear}` : ''}.` +
            (input.openItemId
              ? openItemClosed
                ? ` Closed open item: ${openItemClosed.description}.`
                : ' The open item was not closed (not found, not open, or for another client).'
              : '');
          return {
            outcome: 'ok',
            text: `${message}\nLink: ${link}`,
            structured: {
              status: 'filed',
              message,
              document: {
                id: doc.id,
                title,
                clientId: best.clientId,
                clientName: best.name,
                taxYear,
                docType,
                link,
              },
              openItemClosed,
            },
            audited: true,
          };
        },
        { writes: true },
      ),
  );
}
