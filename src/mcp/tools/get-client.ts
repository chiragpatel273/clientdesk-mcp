import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { partitionByAccess } from '../../domain/access.js';
import { findClients, getClientDetail, type ClientDetail } from '../../domain/clients.js';
import { runTool, type ToolContext } from '../run-tool.js';

const ClientRefSchema = z.object({ id: z.string(), name: z.string() });

export const GetClientOutput = {
  status: z.enum(['found', 'ambiguous', 'not_found', 'denied']),
  message: z.string(),
  client: z
    .object({
      id: z.string(),
      name: z.string(),
      entityType: z.string(),
      fiscalYearEnd: z.string().nullable(),
      status: z.string(),
      assignedStaff: z.array(z.object({ name: z.string(), role: z.string() })),
    })
    .optional(),
  contacts: z
    .array(
      z.object({
        name: z.string(),
        email: z.string().nullable(),
        phone: z.string().nullable(),
        isPrimary: z.boolean(),
      }),
    )
    .optional(),
  openItems: z
    .array(
      z.object({
        id: z.string(),
        taxYear: z.number(),
        description: z.string(),
        status: z.string(),
        dueDate: z.string().nullable(),
      }),
    )
    .optional(),
  recentNotes: z.array(z.object({ body: z.string(), author: z.string().nullable(), createdAt: z.string() })).optional(),
  recentDocuments: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        docType: z.string().nullable(),
        taxYear: z.number().nullable(),
        status: z.string(),
        receivedAt: z.string(),
      }),
    )
    .optional(),
  candidates: z.array(ClientRefSchema).optional(),
};

type Output = z.infer<z.ZodObject<typeof GetClientOutput>>;

function summarise(detail: ClientDetail): string {
  const { client, contacts, openItems, recentNotes } = detail;
  const primary = contacts.find((c) => c.isPrimary) ?? contacts[0];
  const open = openItems.filter((o) => o.status === 'open');
  const lines = [
    `${client.name} (${client.id}): ${client.entityType}, fiscal year end ${client.fiscalYearEnd ?? 'not set'}, ${client.status}.`,
    `Team: ${client.assignedStaff.map((s) => `${s.name} (${s.role})`).join(', ') || 'none assigned'}.`,
    primary ? `Primary contact: ${primary.name}${primary.email ? `, ${primary.email}` : ''}.` : 'No contacts on file.',
    open.length
      ? `Open items (${open.length}):\n${open.map((o) => `- [${o.taxYear}] ${o.description}${o.dueDate ? ` (due ${o.dueDate})` : ''}`).join('\n')}`
      : 'No open items.',
  ];
  if (recentNotes[0]) lines.push(`Latest note (${recentNotes[0].createdAt.slice(0, 10)}): ${recentNotes[0].body}`);
  return lines.join('\n');
}

export function registerGetClient(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_client',
    {
      title: 'Get client',
      description:
        "Look up one of the firm's clients by id or name (full or partial) and return their profile, team, " +
        'contacts, open items, latest notes and recent documents. If several clients match, it returns the ' +
        'candidates instead: ask the user which one they mean rather than guessing.',
      inputSchema: {
        client: z.string().min(1).max(200).describe('Client id (for example cl_acme) or a full or partial name'),
      },
      outputSchema: GetClientOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ client: query }) =>
      runTool<Output>(ctx, 'get_client', { client: query }, async () => {
        const matches = await findClients(ctx.db, query);
        if (matches.length === 0) {
          return {
            outcome: 'ok',
            text: `No client matches "${query}".`,
            structured: { status: 'not_found', message: `No client matches "${query}".` },
          };
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
            outcome: 'denied',
            text: message,
            structured: { status: 'denied', message },
            detail: `denied client ids: ${[...denied].join(', ')}`,
          };
        }

        if (visible.length > 1) {
          const message = `${visible.length} clients match "${query}". Ask the user which one they mean.`;
          return {
            outcome: 'ok',
            text: `${message}\n${visible.map((v) => `- ${v.name} (${v.id})`).join('\n')}`,
            structured: { status: 'ambiguous', message, candidates: visible },
          };
        }

        const detail = await getClientDetail(ctx.db, visible[0]!.id);
        if (!detail) {
          return {
            outcome: 'ok',
            text: `No client matches "${query}".`,
            structured: { status: 'not_found', message: `No client matches "${query}".` },
          };
        }
        return {
          outcome: 'ok',
          text: summarise(detail),
          structured: { status: 'found', message: `Found ${detail.client.name}.`, ...detail },
        };
      }),
  );
}
