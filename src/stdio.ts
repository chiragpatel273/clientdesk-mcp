import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from './bootstrap.js';
import { loadConfig } from './config.js';
import { findActorByEmail } from './domain/staff.js';
import { createMcpServer } from './mcp/server.js';
import { createServices } from './services.js';

/**
 * Local entry point for Claude Code: `claude mcp add clientdesk -- npx tsx src/stdio.ts`.
 * stdout carries the MCP protocol, so every log line goes to stderr.
 */
const log = (msg: string) => console.error(`[clientdesk] ${msg}`);

const config = loadConfig();
const services = createServices(config);
const db = await openDatabase(config, log, services);
const email = process.env.CLIENTDESK_USER ?? config.devUser;
const actor = await findActorByEmail(db, email);
if (!actor) {
  log(`No staff member with email ${email}.`);
  process.exit(1);
}

const server = createMcpServer({ db, actor, services });
await server.connect(new StdioServerTransport());
log(
  `Ready as ${actor.name} (${actor.role}); extractor ${services.extractor.name}, embeddings ${services.embedder.model}.`,
);
