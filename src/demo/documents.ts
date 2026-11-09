import type { DocType } from '../ai/extraction.js';
import type { Db } from '../db/index.js';
import { renderTextPdf } from '../documents/pdf-render.js';
import { ingestDocument } from '../domain/documents.js';
import type { AppServices } from '../services.js';
import { engagementPages, invoicePages, ocrNoise, statementPages, taxFormPages } from './templates.js';

/**
 * Documents for the fictional firm. Filed ones back the cited answers in the demo; inbox ones drive the intake
 * moments: a clear invoice (files), a blurry statement that fits two clients (review), and an invoice for a client
 * Tom isn't assigned to (withheld). Every name, number and amount is invented.
 */
interface DemoDocument {
  id: string;
  title: string;
  filename: string;
  pages: string[];
  receivedAt: string;
  filed?: { clientId: string; taxYear: number; docType: DocType; staffId: string };
}

export const DEMO_DOCUMENTS: DemoDocument[] = [
  // ---- Acme Ltd (Maya, Tom) ----
  {
    id: 'doc_acme_engagement_2026',
    title: 'Acme Ltd engagement letter FY2026',
    filename: 'acme-engagement-letter-2026.pdf',
    receivedAt: '2026-01-14T10:00:00Z',
    filed: { clientId: 'cl_acme', taxYear: 2026, docType: 'engagement_letter', staffId: 'st_maya' },
    pages: engagementPages({
      firm: 'Northbridge Advisory',
      client: 'Acme Ltd',
      contact: 'Priya Natarajan',
      taxYear: 2026,
      services: 'Annual accounts, corporation tax return, quarterly bookkeeping review and payroll filings',
      fee: 14400,
      signedDate: '2026-01-20',
      signedBy: 'Priya Natarajan',
      layout: 'labelled',
    }),
  },
  {
    id: 'doc_acme_statement_q3',
    title: 'Acme Ltd bank statement Jul-Sep 2026',
    filename: 'acme-first-harbor-statement-2026-q3.pdf',
    receivedAt: '2026-10-06T09:12:00Z',
    filed: { clientId: 'cl_acme', taxYear: 2026, docType: 'bank_statement', staffId: 'st_tom' },
    pages: statementPages({
      bank: 'First Harbor Bank',
      holder: 'Acme Ltd',
      accountLast4: '6610',
      periodStart: '2026-07-01',
      periodEnd: '2026-09-30',
      opening: 84210.55,
      transactions: [
        ['2026-07-03', 'Customer receipt - Halden Retail', 18250],
        ['2026-07-15', 'Payroll July', -22480.12],
        ['2026-08-02', 'Rent - Bayview Business Park', -6200],
        ['2026-08-15', 'Payroll August', -22480.12],
        ['2026-09-01', 'Customer receipt - Orbis Freight', 31900],
        ['2026-09-15', 'Payroll September', -22910.4],
      ],
      layout: 'labelled',
    }),
  },
  {
    id: 'doc_acme_laptops',
    title: 'Invoice CT-7781 from Cobalt Tech Supply',
    filename: 'cobalt-tech-ct-7781.pdf',
    receivedAt: '2026-09-22T15:40:00Z',
    filed: { clientId: 'cl_acme', taxYear: 2026, docType: 'invoice', staffId: 'st_tom' },
    pages: invoicePages({
      vendor: 'Cobalt Tech Supply',
      vendorAddress: '19 Foundry Lane, Riverton',
      number: 'CT-7781',
      date: '2026-09-18',
      due: '2026-10-18',
      billedTo: 'Acme Ltd',
      lines: [
        ['4 x laptop, 16GB, for the finance team', 5196],
        ['Docking stations x 4', 556],
      ],
      taxRate: 0.08,
      layout: 'labelled',
    }),
  },
  // ---- Harbor & Pine Partners (Maya, Tom) ----
  {
    id: 'doc_harbor_engagement_draft',
    title: 'Harbor & Pine engagement letter FY2026 (unsigned draft)',
    filename: 'harbor-pine-engagement-2026-draft.pdf',
    receivedAt: '2026-10-28T11:00:00Z',
    filed: { clientId: 'cl_harbor_pine', taxYear: 2026, docType: 'engagement_letter', staffId: 'st_maya' },
    pages: engagementPages({
      firm: 'Northbridge Advisory',
      client: 'Harbor & Pine Partners',
      contact: 'Grace Harbor',
      taxYear: 2026,
      services: 'Partnership return, partner capital account schedules and K-1 preparation',
      fee: 9800,
      signedDate: null,
      signedBy: null,
      layout: 'labelled',
    }),
  },
  // ---- Greenfield Bakery LLC (Maya, Tom) ----
  {
    id: 'doc_greenfield_flour',
    title: "Invoice MF-2291 from Miller's Flour Co",
    filename: 'millers-flour-mf-2291.pdf',
    receivedAt: '2026-10-11T08:30:00Z',
    filed: { clientId: 'cl_greenfield', taxYear: 2026, docType: 'invoice', staffId: 'st_tom' },
    pages: invoicePages({
      vendor: "Miller's Flour Co",
      vendorAddress: '2 Mill Road, Easton',
      number: 'MF-2291',
      date: '2026-10-02',
      due: '2026-11-01',
      billedTo: 'Greenfield Bakery LLC',
      lines: [
        ['Organic bread flour, 40 sacks', 1180],
        ['Rye flour, 10 sacks', 340],
      ],
      taxRate: 0,
      layout: 'compact',
    }),
  },
  // ---- Lakeside Dental Group (Ana only) ----
  {
    id: 'doc_lakeside_software',
    title: 'Invoice DS-55012 from DentalSoft Cloud',
    filename: 'dentalsoft-ds-55012.pdf',
    receivedAt: '2026-08-04T13:00:00Z',
    filed: { clientId: 'cl_lakeside', taxYear: 2026, docType: 'invoice', staffId: 'st_ana' },
    pages: invoicePages({
      vendor: 'DentalSoft Cloud',
      vendorAddress: '400 Harbor Way, Suite 12, Port Ellis',
      number: 'DS-55012',
      date: '2026-08-01',
      due: '2026-08-31',
      billedTo: 'Lakeside Dental Group',
      lines: [['Practice management suite, annual licence (6 seats)', 7140]],
      taxRate: 0.06,
      layout: 'labelled',
    }),
  },
  // ---- Elena Petrova (Tom) ----
  {
    id: 'doc_petrova_1099int_2025',
    title: 'Elena Petrova Form 1099-INT 2025',
    filename: 'petrova-1099-int-2025.pdf',
    receivedAt: '2026-02-03T10:00:00Z',
    filed: { clientId: 'cl_petrova', taxYear: 2025, docType: 'tax_form', staffId: 'st_tom' },
    pages: taxFormPages({
      form: '1099-INT',
      taxYear: 2025,
      payer: 'Summit Savings Bank',
      recipient: 'Elena Petrova',
      recipientTinLast4: '3307',
      amount: 1284.66,
      layout: 'labelled',
    }),
  },
  // ---- Hana Kim (Tom) ----
  {
    id: 'doc_kim_w2_2025',
    title: 'Hana Kim Form W-2 2025',
    filename: 'kim-w2-2025.pdf',
    receivedAt: '2026-01-29T16:20:00Z',
    filed: { clientId: 'cl_kim', taxYear: 2025, docType: 'tax_form', staffId: 'st_tom' },
    pages: taxFormPages({
      form: 'W-2',
      taxYear: 2025,
      payer: 'Coastal Health Partners',
      recipient: 'Hana Kim',
      recipientTinLast4: '1132',
      amount: 96450,
      layout: 'labelled',
    }),
  },
  // ---- Samuel Brooks (Tom) ----
  {
    id: 'doc_brooks_1098_2025',
    title: 'Samuel Brooks Form 1098 2025',
    filename: 'brooks-1098-2025.pdf',
    receivedAt: '2026-02-10T09:00:00Z',
    filed: { clientId: 'cl_brooks', taxYear: 2025, docType: 'tax_form', staffId: 'st_tom' },
    pages: taxFormPages({
      form: '1098',
      taxYear: 2025,
      payer: 'Keystone Home Lending',
      recipient: 'Samuel Brooks',
      recipientTinLast4: '9013',
      amount: 11732.4,
      layout: 'labelled',
    }),
  },
  // ---- Okoro Family Trust (Maya, Ana) ----
  {
    id: 'doc_okoro_statement_q3',
    title: 'Okoro Family Trust statement Jul-Sep 2026',
    filename: 'okoro-trust-statement-2026-q3.pdf',
    receivedAt: '2026-10-09T12:00:00Z',
    filed: { clientId: 'cl_okoro_trust', taxYear: 2026, docType: 'bank_statement', staffId: 'st_ana' },
    pages: statementPages({
      bank: 'Meridian Trust Bank',
      holder: 'Okoro Family Trust',
      accountLast4: '2048',
      periodStart: '2026-07-01',
      periodEnd: '2026-09-30',
      opening: 412880.1,
      transactions: [
        ['2026-07-10', 'Dividend - Atlas Index Fund', 5120.44],
        ['2026-08-01', 'Distribution to beneficiary A. Okoro', -12000],
        ['2026-09-10', 'Dividend - Atlas Index Fund', 5318.02],
      ],
      layout: 'compact',
    }),
  },

  // ---- Inbox: the intake demo ----
  {
    // Moment 2: clear match. Satisfies Acme's open item "Fixed asset additions over $2,500".
    id: 'doc_inbox_northwind',
    title: 'Invoice INV-20931 from Northwind Office Supplies',
    filename: 'northwind-inv-20931.pdf',
    receivedAt: '2026-11-08T09:05:00Z',
    pages: invoicePages({
      vendor: 'Northwind Office Supplies',
      vendorAddress: '88 Commerce Street, Riverton',
      number: 'INV-20931',
      date: '2026-11-03',
      due: '2026-12-03',
      billedTo: 'Acme Ltd',
      attention: 'Priya Natarajan',
      lines: [
        ['Server rack, 42U, installed', 2890],
        ['UPS battery backup 3kVA', 1145],
        ['Installation and cabling', 380],
      ],
      taxRate: 0.08,
      layout: 'labelled',
    }),
  },
  {
    // Moment 3: a blurry scan whose holder name fits both Elena Petrova and Elena Petrovic.
    id: 'doc_inbox_blurry_statement',
    title: 'Scanned bank statement (blurry)',
    filename: 'scan-0193.pdf',
    receivedAt: '2026-11-08T09:20:00Z',
    pages: statementPages({
      bank: 'Summit Savings Bank',
      holder: 'Elena Petrov?',
      accountLast4: '5521',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      opening: 6120.4,
      transactions: [
        ['2026-09-02', 'Salary', 4310],
        ['2026-09-05', 'Rent', -1850],
        ['2026-09-19', 'Childcare - Little Oaks', -640],
      ],
      layout: 'labelled',
    }).map((page, i) => ocrNoise(page, 0.12, 7 + i)),
  },
  {
    // Moment 4 (variant): Tom can see the inbox, but this one belongs to Ana's client, so its contents are withheld.
    id: 'doc_inbox_lakeside',
    title: 'Invoice DS-58120 from DentalSoft Cloud',
    filename: 'dentalsoft-ds-58120.pdf',
    receivedAt: '2026-11-08T09:40:00Z',
    pages: invoicePages({
      vendor: 'DentalSoft Cloud',
      vendorAddress: '400 Harbor Way, Suite 12, Port Ellis',
      number: 'DS-58120',
      date: '2026-11-01',
      due: '2026-11-30',
      billedTo: 'Lakeside Dental Group',
      attention: 'Dr. Noah Bell',
      lines: [['Imaging module add-on, annual', 1890]],
      taxRate: 0.06,
      layout: 'labelled',
    }),
  },
];

export async function seedDemoDocuments(db: Db, services: Pick<AppServices, 'files' | 'embedder'>): Promise<number> {
  let added = 0;
  for (const doc of DEMO_DOCUMENTS) {
    const bytes = await renderTextPdf(doc.title, doc.pages);
    const { duplicate } = await ingestDocument(db, services, {
      id: doc.id,
      bytes,
      mimeType: 'application/pdf',
      filename: doc.filename,
      title: doc.title,
      uploadedBy: doc.filed?.staffId ?? 'st_tom',
      receivedAt: doc.receivedAt,
      filed: doc.filed,
    });
    if (!duplicate) added++;
  }
  // The demo's open item closed by an earlier filing, so "received" items show their source document.
  await db.query(
    `update open_items set document_id = 'doc_acme_engagement_2026'
     where client_id = 'cl_acme' and description like 'Signed engagement letter%' and document_id is null`,
  );
  return added;
}
