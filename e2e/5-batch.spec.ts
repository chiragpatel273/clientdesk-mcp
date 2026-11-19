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
