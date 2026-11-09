import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { localEmbedder } from '../src/ai/embeddings.js';
import { rulesExtractor } from '../src/ai/rules-extractor.js';
import { createDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seedDemoDocuments } from '../src/demo/documents.js';
import { seedDemoFirm } from '../src/demo/seed.js';
import { createLinkSigner } from '../src/documents/links.js';
import { findActorByEmail } from '../src/domain/staff.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { AppServices } from '../src/services.js';
import { memoryFileStore } from '../src/storage/files.js';

export const TEST_LINK_SECRET = 'test-link-secret-test-link-secret-0000';

/** Offline services: in-memory files, hashing embedder, rules extractor. No network, no cost. */
export function testServices(overrides: Partial<AppServices> = {}): AppServices {
  return {
    files: memoryFileStore(),
    embedder: localEmbedder(),
    extractor: rulesExtractor(),
    links: createLinkSigner(TEST_LINK_SECRET, new URL('http://localhost:3000')),
    filing: { threshold: 0.85, margin: 0.15 },
    ...overrides,
  };
}

/** A fresh in-memory Postgres with the schema and demo firm loaded (no documents). */
export async function demoDb(): Promise<Db> {
  const db = await createDb('pglite://memory');
  await migrate(db);
  await seedDemoFirm(db);
  return db;
}

/** The demo firm plus its documents (filed library and the three inbox documents). */
export async function demoDbWithDocuments(services: AppServices): Promise<Db> {
  const db = await demoDb();
  await seedDemoDocuments(db, services);
  return db;
}

/** An MCP client connected in-process to a server running as the given staff member. */
export async function connectAs(db: Db, email: string, services: AppServices = testServices()): Promise<Client> {
  const actor = await findActorByEmail(db, email);
  if (!actor) throw new Error(`No staff member ${email}`);
  const server = createMcpServer({ db, actor, services });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Calls a tool and returns its structured result. */
export async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { result, data: result.structuredContent as T };
}

export async function lastAudit(db: Db) {
  const [row] = await db.query<{
    staff_id: string;
    tool: string;
    outcome: string;
    input: unknown;
    detail: string | null;
  }>('select staff_id, tool, outcome, input, detail from audit_log order by id desc limit 1');
  return row;
}

export const MAYA = 'maya@northbridge.example'; // partner
export const TOM = 'tom@northbridge.example'; // assistant
export const ANA = 'ana@northbridge.example'; // assistant
