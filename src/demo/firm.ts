/**
 * Northbridge Advisory: a fictional firm used for the demo and the tests.
 * Every name, email and number here is invented. Look-alike client names
 * (Acme Ltd / Acme Labs Ltd, Elena Petrova / Elena Petrovic) are deliberate:
 * they exercise the "ask, don't guess" path.
 */

export const STAFF = [
  { id: 'st_maya', name: 'Maya Rao', email: 'maya@northbridge.example', role: 'partner' },
  { id: 'st_tom', name: 'Tom Lindqvist', email: 'tom@northbridge.example', role: 'assistant' },
  { id: 'st_ana', name: 'Ana Costa', email: 'ana@northbridge.example', role: 'assistant' },
] as const;

type EntityType = 'individual' | 'company' | 'partnership' | 'trust';

export const CLIENTS: {
  id: string;
  name: string;
  entityType: EntityType;
  fiscalYearEnd: string;
  taxIdLast4: string;
  team: string[];
}[] = [
  {
    id: 'cl_acme',
    name: 'Acme Ltd',
    entityType: 'company',
    fiscalYearEnd: '12-31',
    taxIdLast4: '4821',
    team: ['st_maya', 'st_tom'],
  },
  {
    id: 'cl_acme_labs',
    name: 'Acme Labs Ltd',
    entityType: 'company',
    fiscalYearEnd: '03-31',
    taxIdLast4: '7310',
    team: ['st_maya', 'st_ana'],
  },
  {
    id: 'cl_harbor_pine',
    name: 'Harbor & Pine Partners',
    entityType: 'partnership',
    fiscalYearEnd: '12-31',
    taxIdLast4: '1956',
    team: ['st_maya', 'st_tom'],
  },
  {
    id: 'cl_petrova',
    name: 'Elena Petrova',
    entityType: 'individual',
    fiscalYearEnd: '12-31',
    taxIdLast4: '3307',
    team: ['st_tom'],
  },
  {
    id: 'cl_petrovic',
    name: 'Elena Petrovic',
    entityType: 'individual',
    fiscalYearEnd: '12-31',
    taxIdLast4: '8842',
    team: ['st_ana'],
  },
  {
    id: 'cl_greenfield',
    name: 'Greenfield Bakery LLC',
    entityType: 'company',
    fiscalYearEnd: '12-31',
    taxIdLast4: '5120',
    team: ['st_maya', 'st_tom'],
  },
  {
    id: 'cl_okoro_trust',
    name: 'Okoro Family Trust',
    entityType: 'trust',
    fiscalYearEnd: '12-31',
    taxIdLast4: '6684',
    team: ['st_maya', 'st_ana'],
  },
  {
    id: 'cl_lakeside',
    name: 'Lakeside Dental Group',
    entityType: 'company',
    fiscalYearEnd: '06-30',
    taxIdLast4: '2295',
    team: ['st_ana'],
  },
  {
    id: 'cl_brooks',
    name: 'Samuel Brooks',
    entityType: 'individual',
    fiscalYearEnd: '12-31',
    taxIdLast4: '9013',
    team: ['st_tom'],
  },
  {
    id: 'cl_brightline',
    name: 'Brightline Logistics Inc',
    entityType: 'company',
    fiscalYearEnd: '09-30',
    taxIdLast4: '4478',
    team: ['st_maya', 'st_ana'],
  },
  {
    id: 'cl_kim',
    name: 'Hana Kim',
    entityType: 'individual',
    fiscalYearEnd: '12-31',
    taxIdLast4: '1132',
    team: ['st_tom'],
  },
  {
    id: 'cl_marlow',
    name: 'Marlow Studio LLC',
    entityType: 'company',
    fiscalYearEnd: '12-31',
    taxIdLast4: '7759',
    team: ['st_ana'],
  },
];

export const CONTACTS: { clientId: string; name: string; email: string; phone: string; isPrimary: boolean }[] = [
  { clientId: 'cl_acme', name: 'Priya Natarajan', email: 'priya@acme.example', phone: '+1 555 0101', isPrimary: true },
  { clientId: 'cl_acme', name: 'Leo Grant', email: 'leo@acme.example', phone: '+1 555 0102', isPrimary: false },
  {
    clientId: 'cl_acme_labs',
    name: 'Owen Hart',
    email: 'owen@acmelabs.example',
    phone: '+1 555 0111',
    isPrimary: true,
  },
  {
    clientId: 'cl_harbor_pine',
    name: 'Grace Harbor',
    email: 'grace@harborpine.example',
    phone: '+1 555 0121',
    isPrimary: true,
  },
  {
    clientId: 'cl_harbor_pine',
    name: 'Ivan Pine',
    email: 'ivan@harborpine.example',
    phone: '+1 555 0122',
    isPrimary: false,
  },
  {
    clientId: 'cl_petrova',
    name: 'Elena Petrova',
    email: 'elena.petrova@mail.example',
    phone: '+1 555 0131',
    isPrimary: true,
  },
  {
    clientId: 'cl_petrovic',
    name: 'Elena Petrovic',
    email: 'e.petrovic@mail.example',
    phone: '+1 555 0141',
    isPrimary: true,
  },
  {
    clientId: 'cl_greenfield',
    name: 'Sam Field',
    email: 'sam@greenfieldbakery.example',
    phone: '+1 555 0151',
    isPrimary: true,
  },
  {
    clientId: 'cl_okoro_trust',
    name: 'Adaeze Okoro',
    email: 'adaeze@okoro.example',
    phone: '+1 555 0161',
    isPrimary: true,
  },
  {
    clientId: 'cl_lakeside',
    name: 'Dr. Noah Bell',
    email: 'noah@lakesidedental.example',
    phone: '+1 555 0171',
    isPrimary: true,
  },
  {
    clientId: 'cl_brooks',
    name: 'Samuel Brooks',
    email: 'sam.brooks@mail.example',
    phone: '+1 555 0181',
    isPrimary: true,
  },
  {
    clientId: 'cl_brightline',
    name: 'Mia Torres',
    email: 'mia@brightline.example',
    phone: '+1 555 0191',
    isPrimary: true,
  },
  { clientId: 'cl_kim', name: 'Hana Kim', email: 'hana.kim@mail.example', phone: '+1 555 0201', isPrimary: true },
  {
    clientId: 'cl_marlow',
    name: 'Jonah Marlow',
    email: 'jonah@marlowstudio.example',
    phone: '+1 555 0211',
    isPrimary: true,
  },
];

type ItemStatus = 'open' | 'received' | 'waived';

export const OPEN_ITEMS: {
  clientId: string;
  taxYear: number;
  description: string;
  status: ItemStatus;
  dueDate: string | null;
}[] = [
  {
    clientId: 'cl_acme',
    taxYear: 2026,
    description: 'Bank statements, October to December 2026',
    status: 'open',
    dueDate: '2027-01-15',
  },
  {
    clientId: 'cl_acme',
    taxYear: 2026,
    description: 'Signed engagement letter for FY2026',
    status: 'received',
    dueDate: null,
  },
  { clientId: 'cl_acme', taxYear: 2026, description: 'Q4 payroll summary', status: 'open', dueDate: '2027-01-20' },
  {
    clientId: 'cl_acme',
    taxYear: 2026,
    description: 'Fixed asset additions over $2,500',
    status: 'open',
    dueDate: '2027-01-31',
  },
  {
    clientId: 'cl_acme_labs',
    taxYear: 2026,
    description: 'R&D expense breakdown',
    status: 'open',
    dueDate: '2026-12-15',
  },
  {
    clientId: 'cl_harbor_pine',
    taxYear: 2026,
    description: 'Partner capital account changes',
    status: 'open',
    dueDate: '2027-02-01',
  },
  {
    clientId: 'cl_harbor_pine',
    taxYear: 2026,
    description: 'Signed engagement letter for FY2026',
    status: 'open',
    dueDate: '2026-11-30',
  },
  { clientId: 'cl_petrova', taxYear: 2026, description: 'Brokerage 1099 forms', status: 'open', dueDate: '2027-02-28' },
  { clientId: 'cl_petrovic', taxYear: 2026, description: 'Childcare receipts', status: 'open', dueDate: '2027-02-28' },
  {
    clientId: 'cl_greenfield',
    taxYear: 2026,
    description: 'Supplier invoices over $1,000',
    status: 'open',
    dueDate: '2027-01-31',
  },
  {
    clientId: 'cl_greenfield',
    taxYear: 2026,
    description: 'Equipment lease agreement',
    status: 'received',
    dueDate: null,
  },
  {
    clientId: 'cl_okoro_trust',
    taxYear: 2026,
    description: 'Trust distribution schedule',
    status: 'open',
    dueDate: '2027-01-31',
  },
  {
    clientId: 'cl_lakeside',
    taxYear: 2026,
    description: 'Practice software subscription invoices',
    status: 'open',
    dueDate: '2026-12-31',
  },
  { clientId: 'cl_brooks', taxYear: 2026, description: 'Home office measurements', status: 'waived', dueDate: null },
  {
    clientId: 'cl_brightline',
    taxYear: 2026,
    description: 'Fuel card statements, July to September 2026',
    status: 'open',
    dueDate: '2026-11-30',
  },
  {
    clientId: 'cl_kim',
    taxYear: 2026,
    description: 'Charitable donation receipts',
    status: 'open',
    dueDate: '2027-02-28',
  },
  {
    clientId: 'cl_marlow',
    taxYear: 2026,
    description: 'Contractor payment summary',
    status: 'open',
    dueDate: '2027-01-31',
  },
];

export const NOTES: { clientId: string; authorId: string; body: string; createdAt: string }[] = [
  {
    clientId: 'cl_acme',
    authorId: 'st_tom',
    body: 'Priya says December statements will come in one batch in early January.',
    createdAt: '2026-11-04T10:15:00Z',
  },
  {
    clientId: 'cl_acme',
    authorId: 'st_maya',
    body: 'Year-end planning call held. Considering bringing forward equipment purchase.',
    createdAt: '2026-10-22T14:00:00Z',
  },
  {
    clientId: 'cl_harbor_pine',
    authorId: 'st_maya',
    body: 'New partner joining in January; capital accounts will change.',
    createdAt: '2026-10-30T09:30:00Z',
  },
  {
    clientId: 'cl_brightline',
    authorId: 'st_ana',
    body: 'Fuel card provider changed in August; statements come from two providers.',
    createdAt: '2026-11-02T16:45:00Z',
  },
  {
    clientId: 'cl_greenfield',
    authorId: 'st_tom',
    body: 'Sam prefers WhatsApp for quick questions, email for documents.',
    createdAt: '2026-09-18T11:00:00Z',
  },
];
