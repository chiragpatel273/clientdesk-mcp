import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './run-tool.js';
import { registerAddCrmNote } from './tools/add-crm-note.js';
import { registerExtractDocument } from './tools/extract-document.js';
import { registerFileDocument } from './tools/file-document.js';
import { registerGetClient } from './tools/get-client.js';
import { registerListInbox } from './tools/list-inbox.js';
import { registerListOpenItems } from './tools/list-open-items.js';
import { registerMatchClient } from './tools/match-client.js';
import { registerSearchDocuments } from './tools/search-documents.js';
import { registerSendToReview } from './tools/send-to-review.js';

export const SERVER_INFO = { name: 'clientdesk', version: '1.0.0' } as const;

const INSTRUCTIONS = `ClientDesk connects you to Northbridge Advisory's client records and documents.
- Only use data returned by these tools; do not invent client facts.
- When a lookup returns several candidates, ask the user which client they mean.
- If a tool says the user is not assigned to a client, tell them and suggest asking a partner. Do not try other ways around it.
- Answer document questions from search_documents passages, cite each fact as [n] with the document title and page, and include the link.
- Filing a new document: list_inbox → extract_document → match_client → show the match and ask the user to confirm → file_document → offer add_crm_note.
- When match_client recommends review or file_document refuses, call send_to_review with the reason. Never pick a client yourself.`;

/**
 * Builds a server bound to one signed-in staff member. A new instance is created per HTTP request
 * (stateless transport), so one person's identity can never leak into another person's request.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerGetClient(server, ctx);
  registerSearchDocuments(server, ctx);
  registerListOpenItems(server, ctx);
  registerListInbox(server, ctx);
  registerExtractDocument(server, ctx);
  registerMatchClient(server, ctx);
  registerFileDocument(server, ctx);
  registerAddCrmNote(server, ctx);
  registerSendToReview(server, ctx);
  return server;
}
