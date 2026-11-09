import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDocument, markForReview } from '../../domain/documents.js';
import { runTool, type ToolContext } from '../run-tool.js';

export const SendToReviewOutput = {
  status: z.enum(['sent', 'already_in_review', 'not_allowed', 'not_found']),
  message: z.string(),
};
type Output = z.infer<z.ZodObject<typeof SendToReviewOutput>>;

export function registerSendToReview(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'send_to_review',
    {
      title: 'Send document to review',
      description:
        'Put an inbox document in the human review queue with a reason, instead of guessing. Use it when ' +
        'match_client recommends review, file_document refuses, fields are unreadable, or the user is unsure. ' +
        'A partner resolves it from the dashboard.',
      inputSchema: {
        documentId: z.string().min(1).max(100).describe('Inbox document id'),
        reason: z.string().min(5).max(500).describe('Why a person needs to look, e.g. "matches two clients"'),
      },
      outputSchema: SendToReviewOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool<Output>(ctx, 'send_to_review', input, async () => {
        const doc = await getDocument(ctx.db, input.documentId);
        if (!doc) {
          const message = `No document with id ${input.documentId}.`;
          return { outcome: 'ok', text: message, structured: { status: 'not_found', message } };
        }
        if (doc.status === 'review') {
          const message = 'This document is already in the review queue.';
          return { outcome: 'ok', text: message, structured: { status: 'already_in_review', message } };
        }
        if (doc.status === 'filed') {
          const message = 'Filed documents can’t be sent to review.';
          return { outcome: 'ok', text: message, structured: { status: 'not_allowed', message } };
        }
        if (!(await markForReview(ctx.db, { id: doc.id, reason: input.reason, staffId: ctx.actor.staffId }))) {
          const message = 'The document changed while sending it to review. Check the inbox.';
          return { outcome: 'ok', text: message, structured: { status: 'not_allowed', message } };
        }
        const message = `Sent "${doc.title}" to the review queue: ${input.reason}`;
        return { outcome: 'ok', text: message, structured: { status: 'sent', message } };
      }),
  );
}
