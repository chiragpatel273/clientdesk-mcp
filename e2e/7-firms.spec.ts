import { expect, test } from '@playwright/test';
import { signInAs } from './helpers.js';

test('a second firm’s partner sees only their own firm', async ({ page }) => {
  await signInAs(page, 'Lena Ortiz');
  await expect(page.getByTestId('firm-name')).toHaveText('Harbourline Tax Partners');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await expect(page.getByText('quayside-hb-6011.pdf')).toBeVisible();
  await expect(page.getByText('northwind-inv-20931.pdf')).toHaveCount(0);

  // Another firm's document by id: not found, and the attempt lands in Harbourline's audit log.
  const res = await page.request.get('/api/documents/doc_acme_laptops/file', {
    headers: { 'x-clientdesk-user': 'lena@harbourline.example' },
  });
  expect(res.status()).toBe(404);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('row', { name: /Lena Ortiz.*dashboard:view_document.*Denied/ }).first()).toBeVisible();
  await expect(page.locator('tbody').getByText('Maya Rao')).toHaveCount(0);
});
