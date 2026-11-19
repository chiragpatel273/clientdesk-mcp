import { expect, test } from '@playwright/test';
import { callTool, signInAs, TOM } from './helpers.js';

test('an assistant is refused an unassigned client, and the refusal is in the audit log', async ({ page, request }) => {
  const result = await callTool(request, TOM, 'get_client', { client: 'Lakeside Dental Group' });
  expect(result.status).toBe('denied');
  expect(result.message).toMatch(/not assigned/i);

  // A partner sees the refusal, with its detail, in the audit log.
  await signInAs(page, 'Maya Rao');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' }).click();
  const row = page.getByRole('row', { name: /Tom Lindqvist.*get_client.*Denied/ }).first();
  await expect(row).toBeVisible();
});

test('an assistant sees only their own audit rows, without details, and no batch intake', async ({ page }) => {
  await signInAs(page, 'Tom Lindqvist');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('tbody').getByText('Maya Rao')).toHaveCount(0);

  // The refused lookup's detail names the client: assistants never see details.
  const res = await page.request.get('/api/audit', { headers: { 'x-clientdesk-user': TOM } });
  const body = (await res.json()) as { rows: { detail: string | null; staff: { id: string } }[] };
  expect(body.rows.every((r) => r.detail === null && r.staff.id === 'st_tom')).toBe(true);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByText('Batch intake')).toHaveCount(0);
});
