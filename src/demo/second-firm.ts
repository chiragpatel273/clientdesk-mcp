/**
 * Harbourline Tax Partners: a second fictional firm in the same database, to prove that nothing crosses firms.
 * It deliberately has a client with the same name as one of Northbridge's ("Acme Ltd"), an inbox invoice billed to
 * that name, and staff of its own. Every name, email and number here is invented.
 */
import type { DocType } from '../ai/extraction.js';
import { invoicePages } from './templates.js';

export const HARBOURLINE = { id: 'firm_harbourline', name: 'Harbourline Tax Partners' } as const;

export const HL_STAFF = [
  { id: 'st_hl_lena', name: 'Lena Ortiz', email: 'lena@harbourline.example', role: 'partner' },
  { id: 'st_hl_sam', name: 'Sam Okafor', email: 'sam@harbourline.example', role: 'assistant' },
] as const;

export const HL_CLIENTS = [
  {
    id: 'cl_hl_acme',
    name: 'Acme Ltd', // same name as Northbridge's cl_acme: a different company, in a different firm
    entityType: 'company' as const,
    fiscalYearEnd: '06-30',
    taxIdLast4: '9902',
    team: ['st_hl_lena', 'st_hl_sam'],
  },
  {
    id: 'cl_hl_birchwood',
    name: 'Birchwood Cafe LLC',
    entityType: 'company' as const,
    fiscalYearEnd: '12-31',
    taxIdLast4: '4417',
    team: ['st_hl_lena'],
  },
];

export const HL_CONTACTS = [
  {
    clientId: 'cl_hl_acme',
    name: 'Jonas Reed',
    email: 'jonas@acme-harbour.example',
    phone: '+1 555 0301',
    isPrimary: true,
  },
];

export const HL_OPEN_ITEMS = [
  {
    clientId: 'cl_hl_acme',
    taxYear: 2026,
    description: 'Harbourline: Q2 sales tax workpapers',
    status: 'open' as const,
    dueDate: '2026-12-15',
  },
];

export const HL_NOTES = [
  {
    clientId: 'cl_hl_acme',
    authorId: 'st_hl_lena',
    body: 'Harbourline note: Jonas prefers email over phone.',
    createdAt: '2026-11-02T09:00:00Z',
  },
];

export const HL_DOCUMENTS: {
  id: string;
  title: string;
  filename: string;
  receivedAt: string;
  pages: string[];
  filed?: { clientId: string; taxYear: number; docType: DocType; staffId: string };
}[] = [
  {
    id: 'doc_hl_acme_invoice',
    title: 'Invoice HB-5520 from Quayside Packaging',
    filename: 'quayside-hb-5520.pdf',
    receivedAt: '2026-10-05T11:00:00Z',
    filed: { clientId: 'cl_hl_acme', taxYear: 2026, docType: 'invoice', staffId: 'st_hl_lena' },
    pages: invoicePages({
      vendor: 'Quayside Packaging',
      vendorAddress: '4 Wharf Road, Port Ellis',
      number: 'HB-5520',
      date: '2026-10-01',
      due: '2026-10-31',
      billedTo: 'Acme Ltd',
      lines: [['Harbourline confidential: 1,200 shipping cartons', 1740]],
      taxRate: 0.08,
      layout: 'labelled',
    }),
  },
  {
    // In Harbourline's inbox: billed to "Acme Ltd". It must never be matched against, filed to, or seen by Northbridge.
    id: 'doc_hl_inbox_acme',
    title: 'Invoice HB-6011 from Quayside Packaging',
    filename: 'quayside-hb-6011.pdf',
    receivedAt: '2026-11-10T08:30:00Z',
    pages: invoicePages({
      vendor: 'Quayside Packaging',
      vendorAddress: '4 Wharf Road, Port Ellis',
      number: 'HB-6011',
      date: '2026-11-06',
      due: '2026-12-06',
      billedTo: 'Acme Ltd',
      attention: 'Jonas Reed',
      lines: [['Pallet wrap, 40 rolls', 512]],
      taxRate: 0.08,
      layout: 'labelled',
    }),
  },
];
