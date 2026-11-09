import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FIELDS } from '../../ai/extraction.js';
import { getDocument } from '../../domain/documents.js';
import { computeMatch, ensureExtraction } from '../../domain/intake.js';
import { canSeeDocument } from '../document-access.js';
import { runTool, type ToolContext } from '../run-tool.js';

export const ExtractDocumentOutput = {
  status: z.enum(['extracted', 'not_found', 'denied']),
  message: z.string(),
  document: z.object({ id: z.string(), title: z.string(), status: z.string(), link: z.string() }).optional(),
  docType: z.string().optional(),
  docTypeConfidence: z.number().optional(),
  clientNameOnDocument: z.string().nullable().optional(),
  taxYear: z.number().nullable().optional(),
  fields: z.array(z.object({ name: z.string(), value: z.string().nullable(), confidence: z.number() })).optional(),
  lowConfidenceFields: z.array(z.string()).optional(),
  model: z.string().optional(),
};
type Output = z.infer<z.ZodObject<typeof ExtractDocumentOutput>>;

const LOW = 0.8;

export function registerExtractDocument(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'extract_document',
    {
      title: 'Extract document fields',
      description:
        'Read a document and return its type and key fields (amounts, dates, names, reference numbers), each with a ' +
        'confidence from 0 to 1. Results are cached; refresh re-reads it. Point out fields below 0.8 confidence to ' +
        'the user instead of presenting them as fact.',
      inputSchema: {
        documentId: z.string().min(1).max(100).describe('Document id, e.g. from list_inbox'),
        refresh: z.boolean().default(false).describe('Re-extract even if a cached result exists'),
      },
      outputSchema: ExtractDocumentOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool<Output>(ctx, 'extract_document', input, async () => {
        const doc = await getDocument(ctx.db, input.documentId);
        if (!doc) {
          const message = `No document with id ${input.documentId}.`;
          return { outcome: 'ok', text: message, structured: { status: 'not_found', message } };
        }
        // Filed documents: check access before reading anything.
        if (doc.status === 'filed') {
          const access = await canSeeDocument(ctx, doc, null);
          if (!access.allowed) {
            return {
              outcome: 'denied',
              text: access.reason,
              structured: { status: 'denied', message: access.reason },
              detail: access.detail,
            };
          }
        }

        const extraction = await ensureExtraction(ctx.db, ctx.services, doc, input.refresh);
        if (doc.status !== 'filed') {
          const access = await canSeeDocument(ctx, doc, await computeMatch(ctx.db, ctx.services, doc, extraction));
          if (!access.allowed) {
            return {
              outcome: 'denied',
              text: access.reason,
              structured: { status: 'denied', message: access.reason },
              detail: access.detail,
            };
          }
        }

        const low = extraction.fields.filter((f) => f.confidence < LOW).map((f) => f.name);
        if (extraction.docTypeConfidence < LOW) low.unshift('docType');
        const labels = extraction.docType === 'other' ? [] : FIELDS[extraction.docType];
        const lines = extraction.fields.map((field) => {
          const def = labels.find((d) => d.name === field.name);
          return `- ${field.name}: ${field.value ?? '(not found)'} [${Math.round(field.confidence * 100)}%${def?.required ? ', required' : ''}]`;
        });
        const message =
          `${doc.title}: ${extraction.docType} (${Math.round(extraction.docTypeConfidence * 100)}%)` +
          `${extraction.clientName ? ` for "${extraction.clientName}"` : ''}` +
          `${extraction.taxYear ? `, tax year ${extraction.taxYear}` : ''}.`;
        return {
          outcome: 'ok',
          text: [
            message,
            ...lines,
            low.length
              ? `Low confidence: ${low.join(', ')}. Ask the user to check these.`
              : 'All fields are high confidence.',
          ].join('\n'),
          structured: {
            status: 'extracted',
            message,
            document: {
              id: doc.id,
              title: doc.title,
              status: doc.status,
              link: ctx.services.links.url(doc.id, ctx.actor.staffId),
            },
            docType: extraction.docType,
            docTypeConfidence: extraction.docTypeConfidence,
            clientNameOnDocument: extraction.clientName,
            taxYear: extraction.taxYear,
            fields: extraction.fields,
            lowConfidenceFields: low,
            model: extraction.model,
          },
          detail: `model ${extraction.model}`,
        };
      }),
  );
}
