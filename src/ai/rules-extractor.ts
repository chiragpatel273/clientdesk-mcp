import {
  cleanFields,
  FIELDS,
  normalizeValue,
  type DocType,
  type ExtractedField,
  type Extraction,
  type ExtractionInput,
  type Extractor,
} from './extraction.js';

/**
 * Offline, regex-based extractor: no API key, no cost, deterministic. It is the baseline the accuracy report
 * compares Claude against, and what tests and CI use. It reads labelled fields ("Invoice number: ...") and
 * gives up (null, low confidence) on anything else, including scans with no text layer.
 */

type Pattern = RegExp;
const L = (labels: string) => new RegExp(`^\\s*(?:${labels})\\s*[:#]\\s*(.+?)\\s*$`, 'im');

const PATTERNS: Record<DocType, Record<string, Pattern[]>> = {
  invoice: {
    vendor_name: [L('from|vendor|supplier|issued by')],
    invoice_number: [L('invoice (?:no\\.?|number|#)|inv\\.? ?#|invoice ref(?:erence)?')],
    invoice_date: [L('invoice date|date issued|issue date|date')],
    due_date: [L('due date|payment due|due by')],
    billed_to: [L('bill(?:ed)? to|invoice to|customer|sold to')],
    total_amount: [L('total due|amount due|balance due|total \\(usd\\)|total')],
    tax_amount: [L('sales tax(?: \\([^)]*\\))?|vat(?: \\([^)]*\\))?|tax(?: \\([^)]*\\))?')],
    currency: [L('currency')],
  },
  bank_statement: {
    bank_name: [L('bank|issued by')],
    account_holder: [L('account holder|account name|prepared for|customer')],
    account_last4: [/^\s*account(?: number| no\.?)?\s*:?\s*[*xX•.\s-]*(\d{4})\s*$/im],
    period_start: [/^\s*(?:statement )?period\s*:\s*(.+?)\s+(?:to|through|-)\s+.+$/im, L('period start|from date')],
    period_end: [/^\s*(?:statement )?period\s*:\s*.+?\s+(?:to|through|-)\s+(.+?)\s*$/im, L('period end|to date')],
    opening_balance: [L('opening balance|beginning balance|balance brought forward')],
    closing_balance: [L('closing balance|ending balance|balance carried forward')],
    currency: [L('currency')],
  },
  engagement_letter: {
    client_name: [L('client|prepared for|addressed to')],
    tax_year: [L('tax year|fiscal year|engagement period')],
    services: [L('services|scope(?: of services)?')],
    annual_fee: [L('annual fee|fixed fee|fee')],
    signed_date: [L('date signed|signed on|signature date')],
    signed_by: [L('signed by|signature of')],
  },
  tax_form: {
    form_type: [/\bform\s+(1099-[a-z]{2,4}|w-2|1098)\b/i],
    tax_year: [L('tax year|calendar year|for year')],
    recipient_name: [L("recipient(?:'s)? name|recipient|employee(?:'s)? name|employee|borrower(?:'s)? name|borrower")],
    recipient_tin_last4: [/^\s*(?:recipient(?:'s)? tin|employee(?:'s)? ssn|tin)\s*:?\s*[*xX•\s-]*(\d{4})\s*$/im],
    payer_name: [L("payer(?:'s)? name|payer|employer(?:'s)? name|employer|lender(?:'s)? name|lender")],
    amount: [L('interest income|ordinary dividends|wages, tips, other compensation|wages|mortgage interest received')],
  },
};

const CLIENT_FIELD: Record<DocType, string> = {
  invoice: 'billed_to',
  bank_statement: 'account_holder',
  engagement_letter: 'client_name',
  tax_form: 'recipient_name',
};

function detectType(text: string): { docType: DocType | 'other'; confidence: number } {
  const t = text.toLowerCase();
  if (/engagement letter|letter of engagement|engagement agreement/.test(t)) {
    return { docType: 'engagement_letter', confidence: 0.95 };
  }
  if (/\bform\s+(1099-[a-z]+|w-2|1098)\b/.test(t)) return { docType: 'tax_form', confidence: 0.95 };
  if (/statement/.test(t) && /balance/.test(t)) return { docType: 'bank_statement', confidence: 0.9 };
  if (/invoice/.test(t)) return { docType: 'invoice', confidence: 0.9 };
  return { docType: 'other', confidence: 0.5 };
}

/** Rough OCR-noise score: digits or pipes inside words, per 100 characters. */
function noiseLevel(text: string): number {
  const hits = text.match(/[a-z][0-9|][a-z]|[|]/gi)?.length ?? 0;
  return (hits / Math.max(text.length, 1)) * 100;
}

/** Undo the commonest OCR substitutions inside words, for names only. */
function denoiseName(value: string): string {
  return value
    .replace(/(?<=[a-z])0|0(?=[a-z])/gi, 'o')
    .replace(/(?<=[a-z])[1|]|[1|](?=[a-z])/gi, 'l')
    .replace(/(?<=[a-z])5|5(?=[a-z])/gi, 's');
}

export function rulesExtractor(): Extractor {
  return {
    name: 'rules',
    async extract(input: ExtractionInput): Promise<Extraction> {
      const text = input.pages.join('\n');
      if (!input.textLayer || text.trim().length < 20) {
        return {
          docType: 'other',
          docTypeConfidence: 0.2,
          clientName: null,
          taxYear: null,
          fields: [],
          model: 'rules-v1',
        };
      }
      const { docType, confidence: typeConfidence } = detectType(text);
      if (docType === 'other') {
        return {
          docType,
          docTypeConfidence: typeConfidence,
          clientName: null,
          taxYear: null,
          fields: [],
          model: 'rules-v1',
        };
      }
      const noisy = noiseLevel(text) > 0.5;
      const fields: ExtractedField[] = FIELDS[docType].map((def) => {
        for (const pattern of PATTERNS[docType][def.name] ?? []) {
          const match = text.match(pattern);
          if (!match?.[1]) continue;
          let raw = match[1].trim();
          if (/^(not signed|n\/a|none|-)$/i.test(raw)) return { name: def.name, value: null, confidence: 0.9 };
          if (def.kind === 'name') raw = noisy ? denoiseName(raw) : raw;
          const value = normalizeValue(def.kind, raw);
          if (value === null) return { name: def.name, value: null, confidence: 0.3 };
          return { name: def.name, value, confidence: noisy ? 0.65 : 0.95 };
        }
        // Not found: probably absent if optional; for a required field we likely missed it.
        return { name: def.name, value: null, confidence: def.required ? 0.4 : 0.85 };
      });

      // Currency from symbols when there is no explicit label.
      const currency = fields.find((x) => x.name === 'currency');
      if (currency && currency.value === null) {
        const symbol = text.match(/[$€£]/)?.[0];
        if (symbol) Object.assign(currency, { value: normalizeValue('currency', symbol), confidence: 0.8 });
      }
      // Invoices often put the vendor in the letterhead (first line) instead of a "From:" label.
      const vendor = fields.find((x) => x.name === 'vendor_name');
      if (vendor && vendor.value === null) {
        const first = text
          .split('\n')
          .find((line) => line.trim())
          ?.trim();
        // "Tax Invoice - Acme Supplies" style headings: the vendor follows the document title.
        const name = first?.replace(/^(?:tax )?invoice\s*[-:|]\s*/i, '').trim();
        if (name && !/invoice/i.test(name)) Object.assign(vendor, { value: name, confidence: 0.75 });
      }
      const bank = fields.find((x) => x.name === 'bank_name');
      if (bank && bank.value === null) {
        const first = text
          .split('\n')
          .find((line) => line.trim())
          ?.trim();
        // Letterheads often add a division: "First Harbor Bank - Business Banking" → "First Harbor Bank".
        const name = first?.replace(/\s+[-|]\s+(?:business|personal|private|commercial)\b.*$/i, '').trim();
        if (name) Object.assign(bank, { value: name, confidence: 0.75 });
      }

      const cleaned = cleanFields(docType, fields);
      const get = (name: string) => cleaned.find((x) => x.name === name)?.value ?? null;
      const yearFrom = (date: string | null) => (date ? Number(date.slice(0, 4)) : null);
      const taxYear =
        (get('tax_year') ? Number(get('tax_year')) : null) ??
        yearFrom(get('period_end')) ??
        yearFrom(get('invoice_date'));

      return {
        docType,
        docTypeConfidence: noisy ? Math.min(typeConfidence, 0.75) : typeConfidence,
        clientName: get(CLIENT_FIELD[docType]),
        taxYear,
        fields: cleaned,
        model: 'rules-v1',
      };
    },
  };
}
