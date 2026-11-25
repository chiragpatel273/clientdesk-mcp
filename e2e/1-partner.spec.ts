import { expect, test } from '@playwright/test';
import { signInAs } from './helpers.js';

test('a partner sees every page of the dashboard', async ({ page }) => {
  await signInAs(page, 'Maya Rao');
  const nav = page.getByRole('navigation', { name: 'Main' });

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Every staff member, every call.')).toBeVisible();

  await nav.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();

  await nav.getByRole('link', { name: /Review queue/ }).click();
  await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();

  await nav.getByRole('link', { name: /Inbox/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByText('northwind-inv-20931.pdf')).toBeVisible();
  await expect(page.getByText('Batch intake')).toBeVisible(); // partners only

  await nav.getByRole('link', { name: 'Accuracy' }).click();
  await expect(page.getByRole('heading', { name: 'Accuracy report' })).toBeVisible();
  await expect(page.getByText('Citation accuracy').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Offline baseline (CI)' }).click();
  await expect(page.getByText('rules-v1 (offline baseline)')).toBeVisible();
});
