export const DOC_TYPES = ['invoice', 'bank_statement', 'engagement_letter', 'tax_form'] as const;
export type DocType = (typeof DOC_TYPES)[number];

type FieldKind = 'text' | 'name' | 'date' | 'amount' | 'year' | 'last4' | 'currency';

export interface FieldDef {
  name: string;
  kind: FieldKind;
  description: string;
  /** Required fields drive escalation to the larger model and the review decision. */
  required: boolean;
}

const f = (name: string, kind: FieldKind, description: string, required = false): FieldDef => ({
  name,
  kind,
  description,
  required,
});

/** The fields extracted per document type. The eval scores exactly these. */
export const FIELDS: Record<DocType, FieldDef[]> = {
  invoice: [
    f('vendor_name', 'name', 'Business that issued the invoice', true),
    f('invoice_number', 'text', 'Invoice number or reference', true),
    f('invoice_date', 'date', 'Date the invoice was issued', true),
    f('due_date', 'date', 'Payment due date'),
    f('billed_to', 'name', 'Customer the invoice is addressed to (usually the firm’s client)', true),
    f('total_amount', 'amount', 'Total amount due including tax', true),
    f('tax_amount', 'amount', 'Sales tax / VAT amount'),
    f('currency', 'currency', 'ISO currency code, e.g. USD'),
  ],
  bank_statement: [
    f('bank_name', 'name', 'Bank that issued the statement', true),
    f('account_holder', 'name', 'Name of the account holder', true),
    f('account_last4', 'last4', 'Last 4 digits of the account number only', true),
    f('period_start', 'date', 'First day of the statement period', true),
    f('period_end', 'date', 'Last day of the statement period', true),
    f('opening_balance', 'amount', 'Balance at the start of the period'),
    f('closing_balance', 'amount', 'Balance at the end of the period', true),
    f('currency', 'currency', 'ISO currency code, e.g. USD'),
  ],
  engagement_letter: [
    f('client_name', 'name', 'Client the engagement letter is addressed to', true),
    f('tax_year', 'year', 'Tax or fiscal year the engagement covers', true),
    f('services', 'text', 'Short summary of the services engaged'),
    f('annual_fee', 'amount', 'Agreed fee'),
    f('signed_date', 'date', 'Date the client signed, if signed'),
    f('signed_by', 'name', 'Person who signed for the client, if signed'),
  ],
  tax_form: [
    f('form_type', 'text', 'Form name, e.g. 1099-INT, 1099-DIV, W-2, 1098', true),
    f('tax_year', 'year', 'Tax year of the form', true),
    f('recipient_name', 'name', 'Recipient / employee / borrower the form is about', true),
    f('recipient_tin_last4', 'last4', 'Last 4 digits of the recipient tax id only'),
    f('payer_name', 'name', 'Payer / employer / lender that issued the form', true),
    f('amount', 'amount', 'Main reported amount (interest, dividends, wages or mortgage interest)', true),
  ],
};

export interface ExtractedField {
  name: string;
  /** Normalised: dates YYYY-MM-DD, amounts like 1234.50, years like 2026; null when absent or unreadable. */
  value: string | null;
  /** 0..1: how sure the extractor is that `value` (including null) is right. */
  confidence: number;
}

export interface Extraction {
  docType: DocType | 'other';
  docTypeConfidence: number;
  /** The firm's client this document concerns, as written on the document. */
  clientName: string | null;
  taxYear: number | null;
  fields: ExtractedField[];
  /** Which extractor produced it, e.g. `rules-v1` or `claude-haiku-5-5 → claude-opus-5-5`. */
  model: string;
}

export interface ExtractionInput {
  filename: string | null;
  /** Page texts from the text layer (may be empty strings for scanned pages). */
  pages: string[];
  textLayer: boolean;
  /** The original PDF, for vision extraction of scans. */
  pdf: Uint8Array | null;
}

export interface Extractor {
  readonly name: string;
  extract(input: ExtractionInput): Promise<Extraction>;
}

// ---------- normalisation (shared by extractors and the eval) ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

export function normalizeDate(raw: string): string | null {
  const s = raw.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(+m[2]!)}-${pad(+m[3]!)}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // US style MM/DD/YYYY
  if (m) return `${m[3]}-${pad(+m[1]!)}-${pad(+m[2]!)}`;
  m = s.match(/^(\d{1,2}) ([a-z]{3})[a-z]* (\d{4})$/i); // 12 March 2026
  if (m && MONTHS.includes(m[2]!.toLowerCase())) {
    return `${m[3]}-${pad(MONTHS.indexOf(m[2]!.toLowerCase()) + 1)}-${pad(+m[1]!)}`;
  }
  m = s.match(/^([a-z]{3})[a-z]* (\d{1,2}) (\d{4})$/i); // March 12 2026
  if (m && MONTHS.includes(m[1]!.toLowerCase())) {
    return `${m[3]}-${pad(MONTHS.indexOf(m[1]!.toLowerCase()) + 1)}-${pad(+m[2]!)}`;
  }
  return null;
}

export function normalizeAmount(raw: string): string | null {
  const negative = /^\s*-|\(.*\)/.test(raw);
  const digits = raw.replace(/[^0-9.]/g, '');
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? `${negative ? '-' : ''}${value.toFixed(2)}` : null;
}

export function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Normalises a value by field kind; returns null when it can't be read. */
export function normalizeValue(kind: FieldKind, raw: string | null): string | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (!s) return null;
  switch (kind) {
    case 'date':
      return normalizeDate(s);
    case 'amount':
      return normalizeAmount(s);
    case 'year': {
      const m = s.match(/(20\d{2}|19\d{2})/);
      return m ? m[1]! : null;
    }
    case 'last4': {
      const digits = s.replace(/\D/g, '');
      return digits.length >= 4 ? digits.slice(-4) : null;
    }
    case 'currency': {
      const upper = s.toUpperCase();
      if (upper.includes('$') || upper === 'USD' || upper === 'US DOLLARS') return 'USD';
      if (upper.includes('€') || upper === 'EUR') return 'EUR';
      if (upper.includes('£') || upper === 'GBP') return 'GBP';
      return /^[A-Z]{3}$/.test(upper) ? upper : null;
    }
    case 'name':
    case 'text':
      return normalizeName(s);
  }
}

/** Compares two normalised values: names case- and punctuation-insensitively, everything else exactly. */
export function sameValue(kind: FieldKind, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  if (kind === 'name' || kind === 'text') {
    const clean = (v: string) =>
      v
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    return clean(a) === clean(b);
  }
  return a === b;
}

export function fieldDef(docType: DocType, name: string): FieldDef | undefined {
  return FIELDS[docType].find((d) => d.name === name);
}

/** Keeps only the fields defined for the type, normalised, one entry per defined field. */
export function cleanFields(docType: DocType | 'other', fields: ExtractedField[]): ExtractedField[] {
  if (docType === 'other') return [];
  return FIELDS[docType].map((def) => {
    const found = fields.find((x) => x.name === def.name);
    const value = normalizeValue(def.kind, found?.value ?? null);
    const confidence = Math.min(1, Math.max(0, found?.confidence ?? 0));
    // A value that didn't survive normalisation can't be trusted, whatever the model said.
    return {
      name: def.name,
      value,
      confidence: found?.value && value === null ? Math.min(confidence, 0.3) : confidence,
    };
  });
}

/** The lowest confidence among the required fields (and the document type). */
export function weakestConfidence(extraction: Extraction): number {
  if (extraction.docType === 'other') return extraction.docTypeConfidence;
  const required = FIELDS[extraction.docType].filter((d) => d.required).map((d) => d.name);
  const confidences = extraction.fields.filter((x) => required.includes(x.name)).map((x) => x.confidence);
  return Math.min(extraction.docTypeConfidence, ...confidences);
}

export function fieldValue(extraction: Extraction, name: string): string | null {
  return extraction.fields.find((x) => x.name === name)?.value ?? null;
}
