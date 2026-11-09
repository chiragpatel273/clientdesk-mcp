import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import {
  cleanFields,
  DOC_TYPES,
  FIELDS,
  weakestConfidence,
  type Extraction,
  type ExtractionInput,
  type Extractor,
} from './extraction.js';

/** Small, cheap model first; the larger one only when the first is unsure. */
export const SMALL_MODEL = 'claude-haiku-5-5';
export const LARGE_MODEL = 'claude-opus-5-5';
/** Below this (on the type or any required field) the larger model gets a second look. */
export const ESCALATE_BELOW = 0.8;

const OutputSchema = z.object({
  doc_type: z.enum([...DOC_TYPES, 'other']),
  doc_type_confidence: z.number(),
  client_name: z.string().nullable(),
  tax_year: z.number().int().nullable(),
  fields: z.array(z.object({ name: z.string(), value: z.string().nullable(), confidence: z.number() })),
});
type Output = z.infer<typeof OutputSchema>;

const fieldGuide = DOC_TYPES.map(
  (type) =>
    `${type}:\n${FIELDS[type].map((d) => `  - ${d.name} (${d.kind}${d.required ? ', required' : ''}): ${d.description}`).join('\n')}`,
).join('\n');

// Stable across calls (no dates or ids), so it caches.
const SYSTEM = `You extract structured data from documents received by Northbridge Advisory, an accounting firm.
Clients send invoices, bank statements, engagement letters and tax forms; your output decides which client file the
document goes into, so accuracy matters more than completeness.

Return:
- doc_type: invoice, bank_statement, engagement_letter, tax_form, or other.
- client_name: the firm's client this document concerns, exactly as written: the billed-to party on an invoice, the
  account holder on a bank statement, the addressee of an engagement letter, the recipient on a tax form.
- tax_year: the tax year the document belongs to (the period it covers, not the date it was received).
- fields: one entry per field listed for the doc_type, every field present, value null when absent.

Fields per type:
${fieldGuide}

Formats: dates YYYY-MM-DD; amounts as plain numbers with two decimals (1234.50, no currency symbol or commas);
years as four digits; last4 fields as exactly four digits. Never output a full account or tax id number.

Confidence (0 to 1) means how sure you are the value is right, including when it is null:
- 0.95 or more: printed clearly and unambiguous.
- 0.6 to 0.9: partly legible, inferred from context, or one of several candidates.
- below 0.5: guessing. Prefer null with low confidence over a guess.
If text looks garbled by OCR, read through obvious character substitutions but lower the confidence.`;

function toExtraction(output: Output, model: string): Extraction {
  return {
    docType: output.doc_type,
    docTypeConfidence: Math.min(1, Math.max(0, output.doc_type_confidence)),
    clientName: output.client_name?.trim() || null,
    taxYear: output.tax_year,
    fields: cleanFields(output.doc_type, output.fields),
    model,
  };
}

function userContent(input: ExtractionInput): Anthropic.Beta.BetaContentBlockParam[] {
  const label = input.filename ? ` (file: ${input.filename})` : '';
  if (!input.textLayer && input.pdf) {
    // Scans and photos: send the PDF itself; Claude reads the page images.
    return [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(input.pdf).toString('base64') },
      },
      { type: 'text', text: `Extract the fields from this scanned document${label}.` },
    ];
  }
  const text = input.pages.map((p, i) => `<page number="${i + 1}">\n${p}\n</page>`).join('\n');
  return [{ type: 'text', text: `Extract the fields from this document${label}.\n\n<document>\n${text}\n</document>` }];
}

export function claudeExtractor(options: { apiKey?: string; client?: Anthropic } = {}): Extractor {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });

  async function run(model: string, input: ExtractionInput): Promise<Output> {
    const large = model === LARGE_MODEL;
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent(input) }],
      output_config: { format: betaZodOutputFormat(OutputSchema), effort: large ? 'medium' : 'low' },
      // On a safety decline the API re-runs the request on a fallback model instead of failing.
      ...(large ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    if (response.stop_reason === 'refusal') throw new Error(`${model} declined to extract this document`);
    if (response.stop_reason === 'max_tokens') throw new Error(`${model} ran out of tokens while extracting`);
    if (!response.parsed_output) throw new Error(`${model} returned output that did not match the schema`);
    return response.parsed_output;
  }

  return {
    name: 'claude',
    async extract(input) {
      const first = toExtraction(await run(SMALL_MODEL, input), SMALL_MODEL);
      if (weakestConfidence(first) >= ESCALATE_BELOW) return first;
      return toExtraction(await run(LARGE_MODEL, input), `${SMALL_MODEL} → ${LARGE_MODEL}`);
    },
  };
}
