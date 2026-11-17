/** The extraction prompt and output shape, shared by every model-backed extractor (Claude, Groq). */
import { z } from 'zod';
import { cleanFields, DOC_TYPES, FIELDS, type Extraction, type ExtractionInput } from './extraction.js';

export const OutputSchema = z.object({
  doc_type: z.enum([...DOC_TYPES, 'other']),
  doc_type_confidence: z.number(),
  client_name: z.string().nullable(),
  tax_year: z.number().int().nullable(),
  fields: z.array(z.object({ name: z.string(), value: z.string().nullable(), confidence: z.number() })),
});
export type Output = z.infer<typeof OutputSchema>;

const fieldGuide = DOC_TYPES.map(
  (type) =>
    `${type}:\n${FIELDS[type].map((d) => `  - ${d.name} (${d.kind}${d.required ? ', required' : ''}): ${d.description}`).join('\n')}`,
).join('\n');

// Stable across calls (no dates or ids), so providers can cache it.
export const EXTRACTION_SYSTEM_PROMPT = `You extract structured data from documents received by Northbridge Advisory, an accounting firm.
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
A field that is absent or blank is null, never placeholder text such as "Not signed", "N/A" or "none".

Confidence (0 to 1) means how sure you are the value is right, including when it is null:
- 0.95 or more: printed clearly and unambiguous.
- 0.6 to 0.9: partly legible, inferred from context, or one of several candidates.
- below 0.5: guessing. Prefer null with low confidence over a guess.
If text looks garbled by OCR, read through obvious character substitutions but lower the confidence.`;

export function toExtraction(output: Output, model: string): Extraction {
  return {
    docType: output.doc_type,
    docTypeConfidence: Math.min(1, Math.max(0, output.doc_type_confidence)),
    clientName: output.client_name?.trim() || null,
    taxYear: output.tax_year,
    fields: cleanFields(output.doc_type, output.fields),
    model,
  };
}

/** A text-layer document as the user message: one <page> block per page so citations keep their page. */
export function documentPrompt(input: ExtractionInput): string {
  const label = input.filename ? ` (file: ${input.filename})` : '';
  const text = input.pages.map((p, i) => `<page number="${i + 1}">\n${p}\n</page>`).join('\n');
  return `Extract the fields from this document${label}.\n\n<document>\n${text}\n</document>`;
}
