import { expect, test } from '@playwright/test';

test('the demo visitor can look at everything and change nothing', async ({ page }) => {
  await page.goto('/dashboard/');
  await page.locator('#dev-user').selectOption('__demo__');
  await expect(page.getByText('Demo mode: read-only, fictional data.')).toBeVisible();
  await expect(page.getByText('Demo visitor', { exact: true })).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const [link, heading] of [
    ['Audit log', 'Audit log'],
    [/Review queue/, 'Review queue'],
    [/Inbox/, 'Inbox'],
    ['Accuracy', 'Accuracy report'],
    ['Overview', 'Overview'],
  ] as const) {
    await nav.getByRole('link', { name: link }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }

  // Writes are refused by the server, not just hidden: the upload control is there, and fails.
  await nav.getByRole('link', { name: /Inbox/ }).click();
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'demo-try.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('INVOICE\nTotal due: $1.00'),
    });
  await expect(page.getByText('This is a read-only demo session, so nothing can be changed.')).toBeVisible();

  // ...and the refusal is in the audit log.
  await nav.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('row', { name: /Demo Visitor.*dashboard:upload.*Denied/ }).first()).toBeVisible();

  // Leaving the demo returns to the normal (dev) sign-in.
  await page.getByRole('button', { name: 'Exit demo' }).click();
  await expect(page.locator('#dev-user')).toBeVisible();
});
