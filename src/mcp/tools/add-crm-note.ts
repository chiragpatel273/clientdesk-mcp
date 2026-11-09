import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addNote, addOpenItem } from '../../domain/open-items.js';
import { ClientRefSchema, resolveClient } from '../resolve-client.js';
import { runTool, type ToolContext } from '../run-tool.js';

export const AddCrmNoteOutput = {
  status: z.enum(['added', 'not_found', 'ambiguous', 'denied', 'invalid']),
  message: z.string(),
  client: ClientRefSchema.optional(),
  created: z.object({ kind: z.enum(['note', 'open_item']), id: z.string() }).optional(),
  candidates: z.array(ClientRefSchema).optional(),
};
type Output = z.infer<z.ZodObject<typeof AddCrmNoteOutput>>;

export function registerAddCrmNote(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'add_crm_note',
    {
      title: 'Add CRM note or open item',
      description:
        "Add a note to a client's record, or an open item (something the client still needs to provide). Show the " +
        'user the exact text first. Notes are signed with the user’s name. If several clients match, ask which one.',
      inputSchema: {
        client: z.string().min(1).max(200).describe('Client id or name'),
        body: z.string().min(3).max(2000).describe('The note, or the open item description'),
        kind: z.enum(['note', 'open_item']).default('note').describe('note (default) or open_item'),
        taxYear: z.number().int().min(2000).max(2100).optional().describe('Required for open items'),
        dueDate: z.iso.date().optional().describe('Open items only: due date, YYYY-MM-DD'),
      },
      outputSchema: AddCrmNoteOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) =>
      runTool<Output>(ctx, 'add_crm_note', input, async () => {
        if (input.kind === 'open_item' && !input.taxYear) {
          const message = 'An open item needs a tax year.';
          return { outcome: 'ok', text: message, structured: { status: 'invalid', message } };
        }
        const resolved = await resolveClient(ctx, input.client);
        if ('refusal' in resolved) return resolved.refusal;
        const { client } = resolved;

        if (input.kind === 'open_item') {
          const id = await addOpenItem(ctx.db, {
            clientId: client.id,
            taxYear: input.taxYear!,
            description: input.body,
            dueDate: input.dueDate ?? null,
          });
          const message = `Added open item for ${client.name} (${input.taxYear}): ${input.body}`;
          return {
            outcome: 'ok',
            text: message,
            structured: { status: 'added', message, client, created: { kind: 'open_item', id } },
          };
        }
        const id = await addNote(ctx.db, { clientId: client.id, authorId: ctx.actor.staffId, body: input.body });
        const message = `Added a note to ${client.name}, signed ${ctx.actor.name}.`;
        return {
          outcome: 'ok',
          text: message,
          structured: { status: 'added', message, client, created: { kind: 'note', id } },
        };
      }),
  );
}
