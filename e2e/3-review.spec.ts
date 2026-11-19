import { expect, test } from '@playwright/test';
import { callTool, signInAs, TOM } from './helpers.js';

test('a partner resolves a review item that Claude sent to review', async ({ page, request }) => {
  // As in the demo: Claude, for Tom, matches the blurry statement, finds two look-alike clients and sends it to
  // review instead of guessing.
  const match = await callTool(request, TOM, 'match_client', { documentId: 'doc_inbox_blurry_statement' });
  expect(match.status).toBe('needs_review');
  const sent = await callTool(request, TOM, 'send_to_review', {
    documentId: 'doc_inbox_blurry_statement',
    reason: 'The holder name matches two clients',
  });
  expect(sent.status).toBe('sent');

  await signInAs(page, 'Maya Rao');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /Review queue/ })
    .click();
  await expect(page.getByText('The holder name matches two clients')).toBeVisible();

  await page.getByRole('button', { name: 'File to client' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Elena Petrova', { exact: true }).click();
  await dialog.getByRole('button', { name: 'File document' }).click();
  await expect(page.getByText(/was filed to Elena Petrova/)).toBeVisible();
  await expect(page.getByText('The holder name matches two clients')).toHaveCount(0);
});
