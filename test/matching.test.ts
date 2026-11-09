import { describe, expect, it } from 'vitest';
import { normalizeAmount, normalizeDate, normalizeValue, type Extraction } from '../src/ai/extraction.js';
import { rulesExtractor } from '../src/ai/rules-extractor.js';
import { invoicePages, ocrNoise, statementPages, taxFormPages } from '../src/demo/templates.js';
import { CLIENTS, CONTACTS } from '../src/demo/firm.js';
import { createLinkSigner } from '../src/documents/links.js';
import { chunkPages } from '../src/domain/documents.js';
import { matchClients, nameSimilarity, normalizeEntity } from '../src/domain/matching.js';

const profiles = CLIENTS.map((c) => ({
  id: c.id,
  name: c.name,
  taxIdLast4: c.taxIdLast4,
  contacts: CONTACTS.filter((x) => x.clientId === c.id),
}));
const filing = { threshold: 0.85, margin: 0.15 };

function extraction(clientName: string, fields: Extraction['fields'] = [], nameConfidence = 0.95): Extraction {
  return {
    docType: 'tax_form',
    docTypeConfidence: 0.95,
    clientName,
    taxYear: 2025,
    fields: [{ name: 'recipient_name', value: clientName, confidence: nameConfidence }, ...fields],
    model: 'test',
  };
}

describe('normalisation', () => {
  it('reads common date formats', () => {
    expect(normalizeDate('12 March 2026')).toBe('2026-03-12');
    expect(normalizeDate('03/12/2026')).toBe('2026-03-12');
    expect(normalizeDate('March 12, 2026')).toBe('2026-03-12');
    expect(normalizeDate('2026-3-2')).toBe('2026-03-02');
    expect(normalizeDate('soon')).toBeNull();
  });

  it('reads amounts and last-4 values', () => {
    expect(normalizeAmount('$4,768.20')).toBe('4768.20');
    expect(normalizeAmount('(120.5)')).toBe('-120.50');
    expect(normalizeValue('last4', '***-**-3307')).toBe('3307');
    expect(normalizeValue('currency', '$')).toBe('USD');
  });

  it('strips legal suffixes from entity names', () => {
    expect(normalizeEntity('Acme Ltd.')).toBe('acme');
    expect(normalizeEntity('Harbor & Pine Partners')).toBe('harbor and pine partners');
    expect(nameSimilarity('Acme Ltd', 'ACME LIMITED')).toBe(1);
  });
});

describe('client matching', () => {
  it('files an exact name when no look-alike is close', () => {
    const result = matchClients(extraction('Acme Ltd'), '', profiles, filing);
    expect(result.decision).toBe('file');
    expect(result.candidates[0]?.clientId).toBe('cl_acme');
    expect(result.candidates[1]?.clientId).toBe('cl_acme_labs');
  });

  it('never files a look-alike on the name alone', () => {
    const result = matchClients(extraction('Elena Petrova'), '', profiles, filing);
    expect(result.decision).toBe('review');
    expect(result.reason).toMatch(/Petrova.*Petrovic|Petrovic.*Petrova/);
  });

  it('files a look-alike when a second identifier confirms it', () => {
    const result = matchClients(
      extraction('Elena Petrova', [{ name: 'recipient_tin_last4', value: '3307', confidence: 0.95 }]),
      '',
      profiles,
      filing,
    );
    expect(result.decision).toBe('file');
    expect(result.candidates[0]?.clientId).toBe('cl_petrova');
    expect(result.candidates[0]?.reasons.join(' ')).toContain('Tax id ending 3307 matches');
  });

  it('distrusts a name that contradicts the tax id', () => {
    const result = matchClients(
      extraction('Elena Petrova', [{ name: 'recipient_tin_last4', value: '8842', confidence: 0.95 }]),
      '',
      profiles,
      filing,
    );
    expect(result.candidates[0]?.clientId).toBe('cl_petrovic');
  });

  it('sends a hard-to-read name to review', () => {
    expect(matchClients(extraction('Hana Kim', [], 0.4), '', profiles, filing).decision).toBe('review');
  });

  it('reviews documents with no recognisable client', () => {
    const result = matchClients(extraction('Zephyr Holdings'), '', profiles, filing);
    expect(result).toMatchObject({ decision: 'review', candidates: [] });
  });
});

describe('rules extractor', () => {
  const extract = (pages: string[]) => rulesExtractor().extract({ filename: null, pages, textLayer: true, pdf: null });
  const value = (e: Extraction, name: string) => e.fields.find((f) => f.name === name)?.value;

  it('reads a labelled invoice, including totals on page 2', async () => {
    const e = await extract(
      invoicePages({
        vendor: 'Test Vendor',
        vendorAddress: '1 Road',
        number: 'T-1',
        date: '2026-04-01',
        due: null,
        billedTo: 'Hana Kim',
        lines: [['Thing', 100]],
        taxRate: 0.1,
        layout: 'labelled',
        totalsOnPage2: true,
      }),
    );
    expect(e.docType).toBe('invoice');
    expect(value(e, 'total_amount')).toBe('110.00');
    expect(value(e, 'due_date')).toBeNull();
  });

  it('reads a compact statement and a tax form', async () => {
    const s = await extract(
      statementPages({
        bank: 'Bank A',
        holder: 'Samuel Brooks',
        accountLast4: '1234',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        opening: 10,
        transactions: [['2026-01-02', 'x', 5]],
        layout: 'compact',
      }),
    );
    expect(s).toMatchObject({ docType: 'bank_statement', clientName: 'Samuel Brooks', taxYear: 2026 });
    expect(value(s, 'closing_balance')).toBe('15.00');
    const t = await extract(
      taxFormPages({
        form: '1098',
        taxYear: 2025,
        payer: 'L',
        recipient: 'Samuel Brooks',
        recipientTinLast4: '9013',
        amount: 5,
        layout: 'labelled',
      }),
    );
    expect(t).toMatchObject({ docType: 'tax_form', taxYear: 2025, clientName: 'Samuel Brooks' });
    expect(value(t, 'recipient_tin_last4')).toBe('9013');
  });

  it('lowers confidence on OCR noise and gives up on scans', async () => {
    const noisy = await extract(
      statementPages({
        bank: 'Bank A',
        holder: 'Samuel Brooks',
        accountLast4: '1234',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        opening: 10,
        transactions: [],
        layout: 'labelled',
      }).map((p) => ocrNoise(p, 0.15, 3)),
    );
    expect(Math.max(...noisy.fields.map((f) => f.confidence))).toBeLessThan(0.8);
    const scan = await rulesExtractor().extract({ filename: null, pages: [''], textLayer: false, pdf: null });
    expect(scan.docType).toBe('other');
  });
});

describe('chunking and links', () => {
  it('keeps passages on their page', () => {
    const chunks = chunkPages(['a\n'.repeat(5), 'line\n'.repeat(400)], 200);
    expect(chunks[0]).toMatchObject({ page: 1 });
    expect(chunks.filter((c) => c.page === 2).length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.content.length <= 210)).toBe(true);
  });

  it('signs links that expire and bind the staff member', () => {
    let now = Date.parse('2026-11-09T10:00:00Z');
    const signer = createLinkSigner('x'.repeat(32), new URL('https://cd.example'), () => now);
    const url = new URL(signer.url('doc_1', 'st_tom', 2));
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig')!;
    expect(url.hash).toBe('#page=2');
    expect(signer.verify('doc_1', 'st_tom', exp, sig)).toBe(true);
    expect(signer.verify('doc_1', 'st_maya', exp, sig)).toBe(false);
    expect(signer.verify('doc_2', 'st_tom', exp, sig)).toBe(false);
    now += 2 * 60 * 60 * 1000;
    expect(signer.verify('doc_1', 'st_tom', exp, sig)).toBe(false);
  });
});
