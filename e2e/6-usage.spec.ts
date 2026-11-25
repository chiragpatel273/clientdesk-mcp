import { expect, test } from '@playwright/test';
import { signInAs } from './helpers.js';

test('the Usage page shows the batch upload’s model calls and the eval run', async ({ page }) => {
  await signInAs(page, 'Maya Rao');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Usage' }).click();
  await expect(page.getByRole('heading', { name: 'LLM usage' })).toBeVisible();
  // The batch in 5-batch.spec.ts ran as background jobs: their extraction and embedding calls are here.
  await expect(page.getByRole('row', { name: /^Job/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /rules-v1/ })).toBeVisible();
  // The offline eval run's usage comes from its report.
  await expect(page.getByTestId('eval-usage-baseline')).toContainText(/\d+ calls/);
});

test('assistants have no Usage page', async ({ page }) => {
  await signInAs(page, 'Tom Lindqvist');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Usage' })).toHaveCount(0);
});
