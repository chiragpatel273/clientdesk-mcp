import { expect, test } from '@playwright/test';
import { signInAs } from './helpers.js';

const file = (name: string, lines: string[]) => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(lines.join('\n')),
});

test('batch intake shows each document’s progress until it is filed or sent to review', async ({ page }) => {
  await signInAs(page, 'Maya Rao');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();

  await page
    .getByTestId('batch-input')
    .setInputFiles([
      file('acme-office-supplies.txt', [
        'Paperclip Co',
        'TAX INVOICE',
        'Invoice number: PC-7781',
        'Invoice date: 2026-04-02',
        'Bill to: Acme Ltd',
        'Total due: $312.40',
      ]),
      file('harbor-pine-statement.txt', [
        'Meridian Trust Bank',
        'ACCOUNT STATEMENT',
        'Account holder: Harbor & Pine Partners',
        'Account number: ****4410',
        'Statement period: 1 April 2026 to 30 April 2026',
        'Opening balance: $1,200.00',
        'Closing balance: $1,950.00',
      ]),
      file('unknown-sender.txt', ['A letter that names no client and holds no invoice or statement fields at all.']),
    ]);

  const items = page.getByTestId('batch-item');
  await expect(items).toHaveCount(3);
  // Every job settles (done), shown with its outcome; none dead.
  await expect(page.locator('[data-testid=batch-item][data-status=done]')).toHaveCount(3, { timeout: 20_000 });
  await expect(page.getByText('3 of 3 processed')).toBeVisible();
  await expect(items.filter({ hasText: 'acme-office-supplies.txt' })).toContainText('Filed to Acme Ltd');
  await expect(items.filter({ hasText: 'unknown-sender.txt' })).toContainText('Sent to review');
});

test('batch intake says so when a file was uploaded before, and finishes', async ({ page }) => {
  await signInAs(page, 'Maya Rao');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  const first = file('repeat-me.txt', [
    'TAX INVOICE',
    'Invoice number: RP-100',
    'Bill to: Acme Ltd',
    'Total due: $10.00',
  ]);
  const input = page.getByTestId('batch-input');

  await input.setInputFiles([first]);
  await expect(page.getByText('1 of 1 processed')).toBeVisible();

  // The same bytes again: nothing to process, and the card says why instead of waiting forever.
  await input.setInputFiles([first]);
  await expect(page.locator('[data-testid=batch-item][data-status=duplicate]')).toContainText('Already in ClientDesk');
  await expect(page.getByText('1 of 1 processed')).toBeVisible();

  // Mixed: one new file, one duplicate (under another name). Both are accounted for.
  await input.setInputFiles([
    file('brand-new.txt', ['TAX INVOICE', 'Invoice number: RP-200', 'Bill to: Acme Ltd', 'Total due: $20.00']),
    { ...first, name: 'repeat-renamed.txt' },
  ]);
  await expect(page.getByText('2 of 2 processed')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('batch-item')).toHaveCount(2);
  await expect(page.locator('[data-testid=batch-item][data-status=duplicate]')).toContainText('repeat-renamed.txt');

  // Settled: the page stops asking the server for progress.
  let polls = 0;
  page.on('request', (r) => {
    if (/\/api\/batches\/[^/]+$/.test(r.url())) polls++;
  });
  await page.waitForTimeout(3500);
  expect(polls).toBeLessThanOrEqual(1);
});

test('one file the server refuses does not stop the rest of the batch', async ({ page }) => {
  await signInAs(page, 'Maya Rao');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  // The server fails the first upload only.
  let failed = false;
  await page.route('**/api/batches/*/files', async (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: '{"error":"Could not store that file"}',
    });
  });
  await page
    .getByTestId('batch-input')
    .setInputFiles([
      file('refused.txt', ['TAX INVOICE', 'Invoice number: RF-1', 'Bill to: Acme Ltd', 'Total due: $1.00']),
      file('accepted.txt', ['TAX INVOICE', 'Invoice number: RF-2', 'Bill to: Acme Ltd', 'Total due: $2.00']),
    ]);
  await expect(page.locator('[data-testid=batch-item][data-status=failed]')).toContainText('Could not store that file');
  await expect(page.locator('[data-testid=batch-item][data-status=done]')).toContainText('accepted.txt');
  await expect(page.getByText('1 of 2 processed · 1 not uploaded')).toBeVisible();
});

test('picking more than 25 files says which were left out, and why', async ({ page }) => {
  await signInAs(page, 'Maya Rao');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  // Nothing needs uploading to see the message: refuse the batch itself.
  await page.route('**/api/batches', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"not now"}' }),
  );
  const many = Array.from({ length: 27 }, (_, i) => file(`many-${i + 1}.txt`, [`Document ${i + 1}`]));
  await page
    .getByTestId('batch-input')
    .setInputFiles([...many, { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('x') }]);
  await expect(page.getByText('Only 25 files at a time. Left out: many-26.txt, many-27.txt')).toBeVisible();
  await expect(page.getByText('Skipped (not PDF or .txt, or empty): photo.png')).toBeVisible();
});
