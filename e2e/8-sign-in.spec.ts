import { expect, test } from '@playwright/test';

// Runs in the `oauth` project: AUTH_MODE=oauth, the real sign-in page (see oauth-server.ts).

test('a fresh browser gets the sign-in page, presses Try the demo, and sees every page read-only', async ({ page }) => {
  await page.goto('/dashboard/');
  await expect(page.getByText('Sign in to ClientDesk')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with your firm account' })).toBeVisible();

  await page.getByRole('button', { name: 'Try the demo' }).click();
  await expect(page.getByText('Demo mode: read-only, fictional data.')).toBeVisible();
  await expect(page.getByTestId('firm-name')).toHaveText('Northbridge Advisory');

  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const [link, heading] of [
    ['Audit log', 'Audit log'],
    [/Review queue/, 'Review queue'],
    [/Inbox/, 'Inbox'],
    ['Accuracy', 'Accuracy report'],
    ['Usage', 'LLM usage'],
    ['Overview', 'Overview'],
  ] as const) {
    await nav.getByRole('link', { name: link }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }

  // Still the demo after a reload (it is a cookie), and still refused.
  await page.reload();
  await expect(page.getByText('Demo mode: read-only, fictional data.')).toBeVisible();
  await nav.getByRole('link', { name: /Inbox/ }).click();
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('INVOICE\nTotal due: $1.00') });
  await expect(page.getByText('This is a read-only demo session, so nothing can be changed.')).toBeVisible();
  await nav.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('row', { name: /Demo Visitor.*dashboard:upload.*Denied/ }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Exit demo' }).click();
  await expect(page.getByText('Sign in to ClientDesk')).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);
});

test('staff sign in with the firm account, and sign out', async ({ page }) => {
  await page.goto('/dashboard/');
  await page.getByRole('button', { name: 'Sign in with your firm account' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('maya@northbridge.example')).toBeVisible();
  await expect(page.getByText('Demo mode')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Sign in to ClientDesk')).toBeVisible();
});

test('the dev header and the dev user list do nothing when real sign-in is on', async ({ request }) => {
  const headers = { 'x-clientdesk-user': 'maya@northbridge.example' };
  expect((await request.get('/api/me', { headers })).status()).toBe(401);
  expect((await request.get('/api/staff', { headers })).status()).toBe(401);
  const mcp = await request.post('/mcp', {
    headers: { ...headers, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(mcp.status()).toBe(401);
});
