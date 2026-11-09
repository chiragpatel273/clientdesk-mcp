import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listDocumentsByStatus } from '../../domain/documents.js';
import { runTool, type ToolContext } from '../run-tool.js';

export const ListInboxOutput = {
  status: z.enum(['ok']),
  message: z.string(),
  documents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      filename: z.string().nullable(),
      receivedAt: z.string(),
      pageCount: z.number().nullable(),
      scanned: z.boolean(),
      extracted: z.boolean(),
    }),
  ),
};
type Output = z.infer<z.ZodObject<typeof ListInboxOutput>>;

export function registerListInbox(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_inbox',
    {
      title: 'List inbox',
      description:
        "List documents waiting in the firm's intake inbox (uploaded but not yet filed to a client), newest first. " +
        'To process one: extract_document, then match_client, then ask the user to confirm before file_document.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20).describe('How many documents to list (default 20)'),
      },
      outputSchema: ListInboxOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool<Output>(ctx, 'list_inbox', input, async () => {
        const docs = await listDocumentsByStatus(ctx.db, 'inbox', input.limit);
        const documents = docs.map((d) => ({
          id: d.id,
          title: d.title,
          filename: d.sourceFilename,
          receivedAt: d.receivedAt,
          pageCount: d.pageCount,
          scanned: !d.textLayer,
          extracted: d.extraction !== null,
        }));
        const message = documents.length ? `${documents.length} documents in the inbox.` : 'The inbox is empty.';
        const lines = documents.map(
          (d) =>
            `- ${d.title} (${d.id})${d.filename ? `, file ${d.filename}` : ''}, received ${d.receivedAt.slice(0, 10)}` +
            `${d.scanned ? ', scanned' : ''}`,
        );
        return {
          outcome: 'ok',
          text: [message, ...lines].join('\n'),
          structured: { status: 'ok', message, documents },
        };
      }),
  );
}
