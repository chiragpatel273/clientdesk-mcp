import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './run-tool.js';
import { registerGetClient } from './tools/get-client.js';

export const SERVER_INFO = { name: 'clientdesk', version: '0.1.0' } as const;

const INSTRUCTIONS = `ClientDesk connects you to Northbridge Advisory's client records and documents.
- Only use data returned by these tools; do not invent client facts.
- When a lookup returns several candidates, ask the user which client they mean.
- If a tool says the user is not assigned to a client, tell them and suggest asking a partner. Do not try other ways around it.
- Cite the client id and, for documents, the document title when you answer.`;

/**
 * Builds a server bound to one signed-in staff member. A new instance is created per HTTP request
 * (stateless transport), so one person's identity can never leak into another person's request.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerGetClient(server, ctx);
  return server;
}
