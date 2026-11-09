/**
 * Text templates for fictional documents. Used by the demo firm and by the eval set (eval/dataset.ts).
 * Three layouts per type: `labelled` (clear "Label: value" lines), `compact` (other label wording) and
 * `prose` (values inside sentences, which a label-reading extractor cannot parse). Every name is invented.
 */

export type Layout = 'labelled' | 'compact' | 'prose';

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** 2026-03-12 → "12 March 2026" */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m! - 1]} ${y}`;
}
/** 2026-03-12 → "03/12/2026" */
export function usDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

export interface InvoiceSpec {
  vendor: string;
  vendorAddress: string;
  number: string;
  date: string; // ISO
  due: string | null;
  billedTo: string;
  attention?: string;
  lines: [string, number][];
  taxRate: number; // 0.08 = 8%
  layout: Layout;
  /** Put the totals on a second page (multi-page hard case). */
  totalsOnPage2?: boolean;
}

export function invoiceTotals(spec: InvoiceSpec) {
  const subtotal = spec.lines.reduce((sum, [, amount]) => sum + amount, 0);
  const tax = Math.round(subtotal * spec.taxRate * 100) / 100;
  return { subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
}

export function invoicePages(spec: InvoiceSpec): string[] {
  const { subtotal, tax, total } = invoiceTotals(spec);
  const lineItems = spec.lines.map(([desc, amount]) => `${desc}   $${money(amount)}`);
  const pct = `${Math.round(spec.taxRate * 1000) / 10}%`;
  let head: string[];
  let totals: string[];
  if (spec.layout === 'labelled') {
    head = [
      spec.vendor,
      spec.vendorAddress,
      'INVOICE',
      `Invoice number: ${spec.number}`,
      `Invoice date: ${longDate(spec.date)}`,
      ...(spec.due ? [`Due date: ${longDate(spec.due)}`] : []),
      `Bill to: ${spec.billedTo}`,
      ...(spec.attention ? [`Attention: ${spec.attention}`] : []),
      'Description   Amount',
    ];
    totals = [
      `Subtotal: $${money(subtotal)}`,
      `Sales tax (${pct}): $${money(tax)}`,
      `Total due: $${money(total)}`,
      'Currency: USD',
    ];
  } else if (spec.layout === 'compact') {
    head = [
      `Tax Invoice - ${spec.vendor}`,
      spec.vendorAddress,
      `Inv #: ${spec.number}`,
      `Date issued: ${usDate(spec.date)}`,
      ...(spec.due ? [`Payment due: ${usDate(spec.due)}`] : []),
      `Customer: ${spec.billedTo}`,
      'Item   Price',
    ];
    totals = [`Net: $${money(subtotal)}`, `VAT (${pct}): $${money(tax)}`, `Amount due: $${money(total)}`];
  } else {
    head = [
      spec.vendor,
      spec.vendorAddress,
      `Invoice ${spec.number}`,
      `Thank you for your business, ${spec.billedTo}. This invoice was issued on ${longDate(spec.date)}` +
        (spec.due ? ` and is payable by ${longDate(spec.due)}.` : '.'),
      'Work completed:',
    ];
    totals = [
      `The amount payable is $${money(total)}, which includes $${money(tax)} of sales tax.`,
      'Please quote the invoice reference with your payment.',
    ];
  }
  if (spec.totalsOnPage2) {
    return [
      [...head, ...lineItems, 'Continued on next page'].join('\n'),
      [`${spec.vendor} - page 2`, ...totals].join('\n'),
    ];
  }
  return [[...head, ...lineItems, ...totals].join('\n')];
}

export interface StatementSpec {
  bank: string;
  holder: string;
  accountLast4: string;
  periodStart: string;
  periodEnd: string;
  opening: number;
  transactions: [string, string, number][]; // date ISO, description, amount (+in / -out)
  layout: Layout;
  totalsOnPage2?: boolean;
}

export function statementClosing(spec: StatementSpec): number {
  return Math.round((spec.opening + spec.transactions.reduce((s, [, , a]) => s + a, 0)) * 100) / 100;
}

export function statementPages(spec: StatementSpec): string[] {
  const closing = statementClosing(spec);
  const rows = spec.transactions.map(
    ([d, desc, a]) => `${usDate(d)}  ${desc}  ${a < 0 ? '-' : ''}$${money(Math.abs(a))}`,
  );
  let head: string[];
  let totals: string[];
  if (spec.layout === 'labelled') {
    head = [
      spec.bank,
      'ACCOUNT STATEMENT',
      `Account holder: ${spec.holder}`,
      `Account number: ****${spec.accountLast4}`,
      `Statement period: ${longDate(spec.periodStart)} to ${longDate(spec.periodEnd)}`,
      `Opening balance: $${money(spec.opening)}`,
      'Date  Description  Amount',
    ];
    totals = [`Closing balance: $${money(closing)}`, 'Currency: USD'];
  } else if (spec.layout === 'compact') {
    head = [
      `${spec.bank} - Business Banking`,
      'Statement of account',
      `Account name: ${spec.holder}`,
      `Account no. XXXX-XXXX-${spec.accountLast4}`,
      `Period: ${usDate(spec.periodStart)} through ${usDate(spec.periodEnd)}`,
      `Beginning balance: $${money(spec.opening)}`,
    ];
    totals = [`Ending balance: $${money(closing)}`];
  } else {
    head = [
      spec.bank,
      `Your statement, ${spec.holder}`,
      `This statement covers ${longDate(spec.periodStart)} to ${longDate(spec.periodEnd)} for the account ending in ${spec.accountLast4}.`,
      `You started the period with $${money(spec.opening)}.`,
      'Activity:',
    ];
    totals = [`At the end of the period your balance was $${money(closing)}.`];
  }
  if (spec.totalsOnPage2) {
    return [[...head, ...rows].join('\n'), [`${spec.bank} - statement page 2`, ...totals].join('\n')];
  }
  return [[...head, ...rows, ...totals].join('\n')];
}

export interface EngagementSpec {
  firm: string;
  client: string;
  contact: string;
  taxYear: number;
  services: string;
  fee: number;
  signedDate: string | null;
  signedBy: string | null;
  layout: Layout;
}

export function engagementPages(spec: EngagementSpec): string[] {
  const signed = spec.signedDate && spec.signedBy;
  if (spec.layout === 'prose') {
    return [
      [
        `${spec.firm}`,
        'Letter of engagement',
        `Dear ${spec.contact},`,
        `Thank you for choosing us. This letter confirms that ${spec.client} engages ${spec.firm} for the ${spec.taxYear} tax year.`,
        `We will provide ${spec.services.toLowerCase()}.`,
        `Our fee for this work is $${money(spec.fee)}, billed in four quarterly instalments.`,
        signed
          ? `Accepted and agreed on behalf of the client by ${spec.signedBy} on ${longDate(spec.signedDate!)}.`
          : 'Please sign and return a copy of this letter.',
      ].join('\n'),
    ];
  }
  const labels =
    spec.layout === 'labelled'
      ? {
          client: 'Client',
          year: 'Tax year',
          services: 'Services',
          fee: 'Annual fee',
          by: 'Signed by',
          date: 'Date signed',
        }
      : {
          client: 'Prepared for',
          year: 'Fiscal year',
          services: 'Scope of services',
          fee: 'Fixed fee',
          by: 'Signature of',
          date: 'Signed on',
        };
  return [
    [
      spec.firm,
      'ENGAGEMENT LETTER',
      `${labels.client}: ${spec.client}`,
      `${labels.year}: ${spec.taxYear}`,
      `${labels.services}: ${spec.services}`,
      `${labels.fee}: $${money(spec.fee)}`,
      'Responsibilities: the client provides complete records on time; we prepare and file the returns listed above.',
    ].join('\n'),
    [
      'ACCEPTANCE',
      `${labels.by}: ${signed ? spec.signedBy : 'Not signed'}`,
      `${labels.date}: ${signed ? longDate(spec.signedDate!) : 'Not signed'}`,
    ].join('\n'),
  ];
}

export interface TaxFormSpec {
  form: '1099-INT' | '1099-DIV' | 'W-2' | '1098';
  taxYear: number;
  payer: string;
  recipient: string;
  recipientTinLast4: string | null;
  amount: number;
  layout: Layout;
}

const AMOUNT_LABEL: Record<TaxFormSpec['form'], string> = {
  '1099-INT': 'Interest income',
  '1099-DIV': 'Ordinary dividends',
  'W-2': 'Wages, tips, other compensation',
  '1098': 'Mortgage interest received',
};

export function taxFormPages(spec: TaxFormSpec): string[] {
  const role =
    spec.form === 'W-2'
      ? { payer: 'Employer', recipient: 'Employee' }
      : spec.form === '1098'
        ? { payer: 'Lender', recipient: 'Borrower' }
        : { payer: 'Payer', recipient: 'Recipient' };
  const tin = spec.recipientTinLast4 ? `***-**-${spec.recipientTinLast4}` : null;
  if (spec.layout === 'prose') {
    return [
      [
        `${spec.payer}`,
        `Form ${spec.form} summary for ${spec.taxYear}`,
        `This summary reports ${AMOUNT_LABEL[spec.form].toLowerCase()} of $${money(spec.amount)} paid to ${spec.recipient}` +
          (tin ? ` (taxpayer id ending ${spec.recipientTinLast4}).` : '.'),
        'Keep this for your tax records.',
      ].join('\n'),
    ];
  }
  const tinLabel = spec.form === 'W-2' ? "Employee's SSN" : "Recipient's TIN";
  return [
    [
      `Form ${spec.form}`,
      `${spec.layout === 'labelled' ? 'Tax year' : 'Calendar year'}: ${spec.taxYear}`,
      `${spec.layout === 'labelled' ? `${role.payer}'s name` : role.payer}: ${spec.payer}`,
      `${spec.layout === 'labelled' ? `${role.recipient}'s name` : role.recipient}: ${spec.recipient}`,
      ...(tin ? [`${tinLabel}: ${tin}`] : []),
      `${AMOUNT_LABEL[spec.form]}: $${money(spec.amount)}`,
      'Copy B - for recipient. This is important tax information.',
    ].join('\n'),
  ];
}

/**
 * Simulated OCR noise for "scan" hard cases: deterministic character substitutions typical of a poor scan.
 * `level` is the fraction of eligible characters changed.
 */
export function ocrNoise(text: string, level: number, seed: number): string {
  const swaps: Record<string, string> = { o: '0', l: '1', i: '|', e: 'c', a: 'o', s: '5', B: '8', m: 'rn' };
  let state = seed || 1;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : [...line].map((ch) => (swaps[ch] && rand() < level ? swaps[ch] : ch)).join('')))
    .join('\n');
}
