import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listOpenItems } from '../../domain/open-items.js';
import { ClientRefSchema, resolveClient } from '../resolve-client.js';
import { runTool, type ToolContext } from '../run-tool.js';

export const ListOpenItemsOutput = {
  status: z.enum(['found', 'not_found', 'ambiguous', 'denied']),
  message: z.string(),
  client: ClientRefSchema.optional(),
  items: z
    .array(
      z.object({
        id: z.string(),
        taxYear: z.number(),
        description: z.string(),
        status: z.string(),
        dueDate: z.string().nullable(),
        document: z.object({ id: z.string(), title: z.string(), link: z.string() }).nullable(),
      }),
    )
    .optional(),
  candidates: z.array(ClientRefSchema).optional(),
};
type Output = z.infer<z.ZodObject<typeof ListOpenItemsOutput>>;

export function registerListOpenItems(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_open_items',
    {
      title: 'List open items',
      description:
        'List what a client still owes the firm (missing documents and information) for a tax year, with due dates. ' +
        'Use for questions like "what is still missing for Acme Ltd\'s 2026 return?". Received items link to the ' +
        'document that closed them. If several clients match, ask the user which one they mean.',
      inputSchema: {
        client: z.string().min(1).max(200).describe('Client id or name'),
        taxYear: z.number().int().min(2000).max(2100).optional().describe('Tax year; all years if omitted'),
        status: z.enum(['open', 'received', 'waived', 'all']).default('open').describe('Which items (default open)'),
      },
      outputSchema: ListOpenItemsOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool<Output>(ctx, 'list_open_items', input, async () => {
        const resolved = await resolveClient(ctx, input.client);
        if ('refusal' in resolved) return resolved.refusal;
        const { client } = resolved;

        const items = (await listOpenItems(ctx.db, client.id, input.taxYear, input.status)).map((item) => ({
          ...item,
          document: item.document
            ? { ...item.document, link: ctx.services.links.url(item.document.id, ctx.actor.staffId) }
            : null,
        }));
        const scope = `${client.name}${input.taxYear ? ` for ${input.taxYear}` : ''}`;
        const label = input.status === 'all' ? 'items' : `${input.status} items`;
        const message = items.length ? `${items.length} ${label} for ${scope}.` : `No ${label} for ${scope}.`;
        const lines = items.map(
          (i) =>
            `- [${i.taxYear}] ${i.description} (${i.status}${i.dueDate ? `, due ${i.dueDate}` : ''})` +
            (i.document ? ` — ${i.document.title}: ${i.document.link}` : ''),
        );
        return {
          outcome: 'ok',
          text: [message, ...lines].join('\n'),
          structured: { status: 'found', message, client, items },
        };
      }),
  );
}
