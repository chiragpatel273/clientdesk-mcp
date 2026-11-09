import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DOC_TYPES } from '../../ai/extraction.js';
import { accessibleClientIds } from '../../domain/access.js';
import { searchDocuments } from '../../domain/search.js';
import { ClientRefSchema, resolveClient } from '../resolve-client.js';
import { runTool, type ToolContext } from '../run-tool.js';

export const SearchDocumentsOutput = {
  status: z.enum(['ok', 'no_results', 'not_found', 'ambiguous', 'denied']),
  message: z.string(),
  passages: z
    .array(
      z.object({
        ref: z.number(),
        documentId: z.string(),
        title: z.string(),
        clientId: z.string(),
        clientName: z.string(),
        taxYear: z.number().nullable(),
        docType: z.string().nullable(),
        page: z.number().nullable(),
        excerpt: z.string(),
        link: z.string(),
      }),
    )
    .optional(),
  candidates: z.array(ClientRefSchema).optional(),
};
type Output = z.infer<z.ZodObject<typeof SearchDocumentsOutput>>;

const EXCERPT_CHARS = 600;

export function registerSearchDocuments(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_documents',
    {
      title: 'Search documents',
      description:
        "Search the firm's filed client documents (invoices, bank statements, engagement letters, tax forms) and " +
        'return the most relevant passages with document title, client, page and a link. Only documents for clients ' +
        'the user is assigned to are searched. Base answers on these passages only, cite each fact as [n] with the ' +
        "document title and page, and include the link. If nothing relevant comes back, say so; don't fill gaps.",
      inputSchema: {
        query: z.string().min(2).max(500).describe('What to look for, in plain words'),
        client: z.string().min(1).max(200).optional().describe('Limit to one client: id or name'),
        taxYear: z.number().int().min(2000).max(2100).optional().describe('Limit to one tax year'),
        docType: z.enum(DOC_TYPES).optional().describe('Limit to one document type'),
        limit: z.number().int().min(1).max(10).default(5).describe('Passages to return (default 5)'),
      },
      outputSchema: SearchDocumentsOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool<Output>(ctx, 'search_documents', input, async () => {
        let clientId: string | undefined;
        if (input.client) {
          const resolved = await resolveClient(ctx, input.client);
          if ('refusal' in resolved) return resolved.refusal;
          clientId = resolved.client.id;
        }

        const passages = await searchDocuments(ctx.db, ctx.services.embedder, input.query, {
          allowedClientIds: await accessibleClientIds(ctx.db, ctx.actor),
          clientId,
          taxYear: input.taxYear,
          docType: input.docType,
          limit: input.limit,
        });
        if (passages.length === 0) {
          const message = 'No filed documents match that search.';
          return { outcome: 'ok', text: message, structured: { status: 'no_results', message, passages: [] } };
        }

        const results = passages.map((p, i) => ({
          ref: i + 1,
          documentId: p.documentId,
          title: p.title,
          clientId: p.clientId,
          clientName: p.clientName,
          taxYear: p.taxYear,
          docType: p.docType,
          page: p.page,
          excerpt: p.content.length > EXCERPT_CHARS ? `${p.content.slice(0, EXCERPT_CHARS)}…` : p.content,
          link: ctx.services.links.url(p.documentId, ctx.actor.staffId, p.page),
        }));
        const text = results
          .map(
            (r) =>
              `[${r.ref}] ${r.title} (${r.clientName}${r.taxYear ? `, ${r.taxYear}` : ''}${r.page ? `, page ${r.page}` : ''})\n` +
              `Link: ${r.link}\n${r.excerpt}`,
          )
          .join('\n\n');
        return {
          outcome: 'ok',
          text: `${results.length} passages. Cite them as [n] with title and page.\n\n${text}`,
          structured: { status: 'ok', message: `${results.length} passages found.`, passages: results },
          detail: `${results.length} passages from ${new Set(results.map((r) => r.documentId)).size} documents`,
        };
      }),
  );
}
