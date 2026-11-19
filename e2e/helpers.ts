import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const MAYA = 'maya@northbridge.example';
export const TOM = 'tom@northbridge.example';

/** Signs in through the dev user picker (AUTH_MODE=dev), the way a developer would. */
export async function signInAs(page: Page, name: 'Maya Rao' | 'Tom Lindqvist' | 'Ana Costa') {
  await page.goto('/dashboard/');
  const picker = page.locator('#dev-user');
  await expect(picker).toBeVisible();
  const value = await picker.locator('option', { hasText: name }).getAttribute('value');
  await picker.selectOption(value!);
  await expect(picker).toHaveValue(value!);
}

/** Calls an MCP tool over the real Streamable HTTP endpoint as a staff member (dev auth header). */
export async function callTool(
  request: APIRequestContext,
  user: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: string; message: string }> {
  const res = await request.post('/mcp', {
    headers: { 'x-clientdesk-user': user, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.ok()).toBe(true);
  const body = await res.text();
  // The response may come as JSON or as one server-sent event.
  const json = JSON.parse(
    body.startsWith('{')
      ? body
      : body
          .split('\n')
          .find((l) => l.startsWith('data: '))!
          .slice(6),
  );
  return json.result.structuredContent;
}
