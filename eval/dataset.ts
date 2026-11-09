/**
 * The labelled accuracy set: 60 synthetic documents (15 per type) and 30 search questions.
 * Deterministic (seeded), so every run scores the same documents. All names and numbers are invented.
 *
 * Hard cases per type: prose layout (values inside sentences), simulated scans (OCR-style character noise in the
 * text layer), look-alike clients (Acme Ltd / Acme Labs Ltd, Elena Petrova / Elena Petrovic), missing fields,
 * prior-year documents, multi-page documents (totals on page 2), name variants, and a document for a non-client.
 */
import type { DocType } from '../src/ai/extraction.js';
import {
  engagementPages,
  invoicePages,
  invoiceTotals,
  ocrNoise,
  statementClosing,
  statementPages,
  taxFormPages,
  type Layout,
} from '../src/demo/templates.js';

export type HardCase =
  | 'prose layout'
  | 'scan (OCR noise)'
  | 'look-alike client'
  | 'look-alike, no second id'
  | 'missing fields'
  | 'prior year'
  | 'multi-page'
  | 'name variant'
  | 'not a client';

export interface EvalDocument {
  id: string;
  docType: DocType;
  hardCase: HardCase | null;
  pages: string[];
  /** The client it really belongs to (null: not a client of the firm). */
  clientId: string | null;
  /**
   * What a careful person following firm policy would do: file it, or send it to review
   * (look-alike client with no second identifier, unreadable owner, or not a client).
   */
  expectedAction: 'file' | 'review';
  taxYear: number;
  /** Ground truth for every field of the type; null means "not on the document". */
  fields: Record<string, string | null>;
}

export interface EvalQuestion {
  id: string;
  question: string;
  documentId: string;
  /** The page holding the answer. */
  page: number;
  paraphrased: boolean;
}

// ---------- deterministic helpers ----------

function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
const rand = rng(20261109);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const amount = (min: number, max: number) => Math.round((min + rand() * (max - min)) * 100) / 100;
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const fixed = (n: number) => n.toFixed(2);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const NAMES: Record<string, string[]> = {
  cl_acme: ['Acme Ltd', 'ACME LTD', 'Acme Limited'],
  cl_acme_labs: ['Acme Labs Ltd', 'Acme Labs Limited'],
  cl_harbor_pine: ['Harbor & Pine Partners', 'Harbor and Pine Partners'],
  cl_greenfield: ['Greenfield Bakery LLC', 'Greenfield Bakery'],
  cl_lakeside: ['Lakeside Dental Group'],
  cl_brightline: ['Brightline Logistics Inc', 'Brightline Logistics'],
  cl_marlow: ['Marlow Studio LLC', 'Marlow Studio'],
  cl_okoro_trust: ['Okoro Family Trust', 'The Okoro Family Trust'],
  cl_petrova: ['Elena Petrova'],
  cl_petrovic: ['Elena Petrovic'],
  cl_brooks: ['Samuel Brooks', 'SAMUEL BROOKS'],
  cl_kim: ['Hana Kim', 'HANA KIM'],
};
const TIN: Record<string, string> = {
  cl_petrova: '3307',
  cl_petrovic: '8842',
  cl_brooks: '9013',
  cl_kim: '1132',
  cl_okoro_trust: '6684',
};
const BUSINESSES = [
  'cl_acme',
  'cl_acme_labs',
  'cl_harbor_pine',
  'cl_greenfield',
  'cl_lakeside',
  'cl_brightline',
  'cl_marlow',
];
const INDIVIDUALS = ['cl_brooks', 'cl_kim', 'cl_okoro_trust'];
const VENDORS = [
  ['Northwind Office Supplies', '88 Commerce Street, Riverton'],
  ['Cobalt Tech Supply', '19 Foundry Lane, Riverton'],
  ['Bright Spark Electrical', '7 Volt Avenue, Easton'],
  ['Harbor Freight Couriers', 'Pier 4, Port Ellis'],
  ['Juniper Legal LLP', '55 Court Row, Riverton'],
  ['Summit Cleaning Services', '3 Station Road, Easton'],
  ['Pixel & Print Studio', '12 Market Square, Riverton'],
  ['Atlas Insurance Brokers', '900 Bay Street, Port Ellis'],
] as const;
const ITEMS = [
  'Monthly support retainer',
  'Office chairs x 6',
  'Courier services, October',
  'Legal review of lease',
  'Deep clean of premises',
  'Brochure printing, 2,000 copies',
  'Annual liability premium',
  'Network switch and cabling',
  'Consulting, 12 hours',
];
const BANKS = ['First Harbor Bank', 'Summit Savings Bank', 'Meridian Trust Bank', 'Coastline Credit Union'];

// ---------- generators ----------

type Variant = { hardCase: HardCase | null; layout: Layout; noise?: boolean; multiPage?: boolean };

/** The same 15-slot plan for every type: 7 clean, then one or two of each hard case. */
const PLAN: Variant[] = [
  { hardCase: null, layout: 'labelled' },
  { hardCase: null, layout: 'labelled' },
  { hardCase: null, layout: 'labelled' },
  { hardCase: null, layout: 'compact' },
  { hardCase: null, layout: 'compact' },
  { hardCase: 'name variant', layout: 'labelled' },
  { hardCase: 'name variant', layout: 'compact' },
  { hardCase: 'prose layout', layout: 'prose' },
  { hardCase: 'prose layout', layout: 'prose' },
  { hardCase: 'scan (OCR noise)', layout: 'labelled', noise: true },
  { hardCase: 'scan (OCR noise)', layout: 'compact', noise: true },
  { hardCase: 'look-alike client', layout: 'labelled' },
  { hardCase: 'missing fields', layout: 'labelled' },
  { hardCase: 'prior year', layout: 'compact' },
  { hardCase: 'multi-page', layout: 'labelled', multiPage: true },
];

/** Deals clients from a shuffled pool without repeats until it runs out, like a firm's spread of documents. */
function dealer(pool: string[]): () => string {
  let deck: string[] = [];
  return () => {
    if (deck.length === 0) deck = [...pool].sort(() => rand() - 0.5);
    return deck.pop()!;
  };
}

function clientFor(variant: Variant, next: () => string, lookAlikes: string[]): { clientId: string; name: string } {
  const clientId = variant.hardCase === 'look-alike client' ? pick(lookAlikes) : next();
  const names = NAMES[clientId]!;
  return { clientId, name: variant.hardCase === 'name variant' && names.length > 1 ? names[1]! : names[0]! };
}

function finish(variant: Variant, pages: string[], seed: number): string[] {
  return variant.noise ? pages.map((p, i) => ocrNoise(p, 0.1, seed + i)) : pages;
}

function invoices(): EvalDocument[] {
  const next = dealer(BUSINESSES);
  return PLAN.map((variant, i) => {
    const { clientId, name } = clientFor(variant, next, ['cl_acme', 'cl_acme_labs']);
    const [vendor, address] = VENDORS[i % VENDORS.length]!;
    const year = variant.hardCase === 'prior year' ? 2025 : 2026;
    const month = 1 + Math.floor(rand() * 10);
    const date = iso(year, month, 1 + Math.floor(rand() * 27));
    const due = variant.hardCase === 'missing fields' ? null : iso(year, month + 1, 1 + Math.floor(rand() * 27));
    const taxRate = variant.hardCase === 'missing fields' ? 0 : pick([0.06, 0.08, 0.1]);
    const lines: [string, number][] = [
      [pick(ITEMS), amount(120, 4000)],
      ...(rand() > 0.5 ? [[pick(ITEMS), amount(80, 900)] as [string, number]] : []),
    ];
    const spec = {
      vendor,
      vendorAddress: address,
      number: `${vendor.slice(0, 2).toUpperCase()}-${10000 + Math.floor(rand() * 89999)}`,
      date,
      due,
      billedTo: name,
      lines,
      taxRate,
      layout: variant.layout,
      totalsOnPage2: variant.multiPage,
    };
    const { tax, total } = invoiceTotals(spec);
    return {
      id: `inv_${String(i + 1).padStart(2, '0')}`,
      docType: 'invoice' as const,
      hardCase: variant.hardCase,
      pages: finish(variant, invoicePages(spec), 100 + i),
      clientId,
      expectedAction: 'file' as const,
      taxYear: year,
      fields: {
        vendor_name: vendor,
        invoice_number: spec.number,
        invoice_date: date,
        due_date: due,
        billed_to: name,
        total_amount: fixed(total),
        tax_amount: fixed(tax), // printed even when zero
        currency: 'USD',
      },
    };
  });
}

function statements(): EvalDocument[] {
  const next = dealer([...BUSINESSES, ...INDIVIDUALS]);
  return PLAN.map((variant, i) => {
    // The look-alike slot here has no second identifier: policy says a person confirms.
    const lookAlike = variant.hardCase === 'look-alike client';
    const { clientId, name } = clientFor(variant, next, ['cl_petrova', 'cl_petrovic']);
    const year = variant.hardCase === 'prior year' ? 2025 : 2026;
    const month = 1 + Math.floor(rand() * 9);
    const start = iso(year, month, 1);
    const end = iso(year, month, lastDay(year, month));
    const opening = amount(500, 90000);
    const transactions: [string, string, number][] = [
      [iso(year, month, 3), 'Deposit', amount(100, 8000)],
      [iso(year, month, 12), 'Card payment', -amount(20, 900)],
      [iso(year, month, 21), 'Transfer out', -amount(100, 3000)],
    ];
    const spec = {
      bank: BANKS[i % BANKS.length]!,
      holder: name,
      accountLast4: String(1000 + Math.floor(rand() * 8999)),
      periodStart: start,
      periodEnd: end,
      opening,
      transactions,
      layout: variant.layout,
      totalsOnPage2: variant.multiPage,
    };
    return {
      id: `stm_${String(i + 1).padStart(2, '0')}`,
      docType: 'bank_statement' as const,
      hardCase: lookAlike ? ('look-alike, no second id' as const) : variant.hardCase,
      pages: finish(variant, statementPages(spec), 200 + i),
      clientId,
      expectedAction: lookAlike ? ('review' as const) : ('file' as const),
      taxYear: year,
      fields: {
        bank_name: spec.bank,
        account_holder: name,
        account_last4: spec.accountLast4,
        period_start: start,
        period_end: end,
        opening_balance: fixed(opening),
        closing_balance: fixed(statementClosing(spec)),
        currency: 'USD',
      },
    };
  });
}

function engagementLetters(): EvalDocument[] {
  const next = dealer([...BUSINESSES, ...INDIVIDUALS]);
  return PLAN.map((variant, i) => {
    // The "missing fields" slot is the unsigned letter; the multi-page slot is the standard 2-page letter.
    const { clientId, name } = clientFor(variant, next, ['cl_acme', 'cl_acme_labs']);
    const year = variant.hardCase === 'prior year' ? 2025 : 2026;
    const signed = variant.hardCase !== 'missing fields';
    const signedDate = signed ? iso(year, 1 + Math.floor(rand() * 2), 1 + Math.floor(rand() * 27)) : null;
    const signer = signed ? pick(['Priya Natarajan', 'Owen Hart', 'Grace Harbor', 'Mia Torres', 'Jonah Marlow']) : null;
    const services = pick([
      'Annual accounts and corporate tax return',
      'Personal tax return and quarterly estimates',
      'Bookkeeping review, payroll filings and year-end accounts',
      'Trust tax return and beneficiary statements',
    ]);
    const fee = Math.round(amount(1500, 18000));
    const spec = {
      firm: 'Northbridge Advisory',
      client: name,
      contact: signer ?? 'Client',
      taxYear: year,
      services,
      fee,
      signedDate,
      signedBy: signer,
      layout: variant.layout,
    };
    return {
      id: `eng_${String(i + 1).padStart(2, '0')}`,
      docType: 'engagement_letter' as const,
      hardCase: variant.hardCase,
      pages: finish(variant, engagementPages(spec), 300 + i),
      clientId,
      expectedAction: 'file' as const,
      taxYear: year,
      fields: {
        client_name: name,
        tax_year: String(year),
        services,
        annual_fee: fixed(fee),
        signed_date: signedDate,
        signed_by: signer,
      },
    };
  });
}

function taxForms(): EvalDocument[] {
  const next = dealer(INDIVIDUALS);
  return PLAN.map((variant, i): EvalDocument => {
    const lookAlike = variant.hardCase === 'look-alike client';
    const { clientId, name } = clientFor(variant, next, ['cl_petrova', 'cl_petrovic']);
    const year = variant.hardCase === 'prior year' ? 2024 : 2025;
    const form =
      clientId === 'cl_okoro_trust'
        ? pick(['1099-INT', '1099-DIV'] as const)
        : pick(['1099-INT', '1099-DIV', 'W-2', '1098'] as const);
    // Look-alikes carry the tax id here, so they can be filed; "missing fields" drops it.
    const tin = variant.hardCase === 'missing fields' ? null : (TIN[clientId] ?? null);
    const payer = pick([
      'Summit Savings Bank',
      'Atlas Index Funds',
      'Coastal Health Partners',
      'Keystone Home Lending',
      'Riverton Credit Union',
    ]);
    const amt = form === 'W-2' ? amount(30000, 140000) : amount(50, 15000);
    const spec = {
      form,
      taxYear: year,
      payer,
      recipient: name,
      recipientTinLast4: tin,
      amount: amt,
      layout: variant.layout,
    };
    return {
      id: `tax_${String(i + 1).padStart(2, '0')}`,
      docType: 'tax_form',
      hardCase: lookAlike ? 'look-alike client' : variant.hardCase === 'multi-page' ? null : variant.hardCase,
      pages: finish(variant, taxFormPages(spec), 400 + i),
      clientId,
      expectedAction: 'file',
      taxYear: year,
      fields: {
        form_type: form,
        tax_year: String(year),
        recipient_name: name,
        recipient_tin_last4: tin,
        payer_name: payer,
        amount: fixed(amt),
      },
    };
  });
}

/** One invoice addressed to a business that is not a client: it must never be filed. */
function withNonClient(docs: EvalDocument[]): EvalDocument[] {
  const target = docs.find((d) => d.id === 'inv_03')!;
  const pages = target.pages.map((p) => p.replaceAll(target.fields.billed_to!, 'Zephyr Marine Holdings'));
  return docs.map((d) =>
    d === target
      ? {
          ...d,
          hardCase: 'not a client' as const,
          pages,
          clientId: null,
          expectedAction: 'review' as const,
          fields: { ...d.fields, billed_to: 'Zephyr Marine Holdings' },
        }
      : d,
  );
}

export const DOCUMENTS: EvalDocument[] = [
  ...withNonClient(invoices()),
  ...statements(),
  ...engagementLetters(),
  ...taxForms(),
];

// ---------- questions ----------

function questionFor(doc: EvalDocument, paraphrased: boolean): Omit<EvalQuestion, 'id'> {
  const f = doc.fields;
  const lastPage = doc.pages.length;
  switch (doc.docType) {
    case 'invoice':
      return paraphrased
        ? {
            question: `How much does ${f.billed_to} owe ${f.vendor_name} in total?`,
            documentId: doc.id,
            page: lastPage,
            paraphrased,
          }
        : {
            question: `What is the total due on invoice ${f.invoice_number} from ${f.vendor_name}?`,
            documentId: doc.id,
            page: lastPage,
            paraphrased,
          };
    case 'bank_statement':
      return paraphrased
        ? {
            question: `What did ${f.account_holder} have left in the ${f.bank_name} account ending ${f.account_last4} at the end of the period?`,
            documentId: doc.id,
            page: lastPage,
            paraphrased,
          }
        : {
            question: `What is the closing balance on the ${f.bank_name} statement for account ${f.account_last4}?`,
            documentId: doc.id,
            page: lastPage,
            paraphrased,
          };
    case 'engagement_letter':
      return paraphrased
        ? {
            question: `How much will ${f.client_name} pay Northbridge for the ${f.tax_year} work?`,
            documentId: doc.id,
            page: 1,
            paraphrased,
          }
        : {
            question: `What fee did ${f.client_name} agree to in the ${f.tax_year} engagement letter?`,
            documentId: doc.id,
            page: 1,
            paraphrased,
          };
    case 'tax_form':
      return paraphrased
        ? {
            question: `What did ${f.payer_name} report for ${f.recipient_name} for ${f.tax_year}?`,
            documentId: doc.id,
            page: 1,
            paraphrased,
          }
        : {
            question: `What amount is on the ${f.tax_year} Form ${f.form_type} from ${f.payer_name} for ${f.recipient_name}?`,
            documentId: doc.id,
            page: 1,
            paraphrased,
          };
  }
}

/** What a question names to pick out its document; a question is only fair if exactly one document has it. */
function identity(doc: EvalDocument): string {
  const f = doc.fields;
  switch (doc.docType) {
    case 'invoice':
      return `inv|${f.invoice_number}`;
    case 'bank_statement':
      return `stm|${f.bank_name}|${f.account_last4}`;
    case 'engagement_letter':
      return `eng|${doc.clientId}|${f.tax_year}`;
    case 'tax_form':
      return `tax|${doc.clientId}|${f.form_type}|${f.payer_name}|${f.tax_year}`;
  }
}
const identityCounts = new Map<string, number>();
for (const doc of DOCUMENTS) identityCounts.set(identity(doc), (identityCounts.get(identity(doc)) ?? 0) + 1);

/** Prose and scans are extraction tests; the non-client and unidentified look-alike are never filed. */
const UNSEARCHABLE: (HardCase | null)[] = ['prose layout', 'scan (OCR noise)', 'not a client', 'look-alike, no second id'];
const eligible = DOCUMENTS.filter(
  (d) => d.clientId !== null && !UNSEARCHABLE.includes(d.hardCase) && identityCounts.get(identity(d)) === 1,
);
// Round-robin over the four types so each gets 7–8 questions, hard cases (multi-page, prior year, look-alike,
// missing fields) first so they are always asked about, then clean documents.
const byType = ['invoice', 'bank_statement', 'engagement_letter', 'tax_form'].map((t) =>
  eligible.filter((d) => d.docType === t).sort((a, b) => Number(a.hardCase === null) - Number(b.hardCase === null)),
);
const ordered: EvalDocument[] = [];
for (let i = 0; ordered.length < 30 && byType.some((list) => list[i]); i++) {
  for (const list of byType) if (list[i] && ordered.length < 30) ordered.push(list[i]!);
}

/** 30 questions with exactly one right document and page; every third one paraphrased. */
export const QUESTIONS: EvalQuestion[] = ordered.map((doc, i) => ({
  id: `q_${String(i + 1).padStart(2, '0')}`,
  ...questionFor(doc, i % 3 === 2),
}));
