import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { localEmbedder } from '../src/ai/embeddings.js';
import { rulesExtractor } from '../src/ai/rules-extractor.js';
import { createDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seedDemoDocuments, seedSecondFirmDocuments } from '../src/demo/documents.js';
import { ensureFirms, seedDemoFirm, seedSecondFirm } from '../src/demo/seed.js';
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

export const NB = 'firm_northbridge';
export const HL = 'firm_harbourline';

/** Northbridge's scoped handle: what every request by a Northbridge staff member gets. */
export const nb = (db: Db): Db => db.forFirm(NB);

/**
 * A fresh in-memory Postgres with the schema and both demo firms loaded (no documents). Returns the unscoped
 * (owner) handle: raw SQL in tests sees every firm; domain functions need `nb(db)` or `db.forFirm(...)`.
 */
export async function demoDb(): Promise<Db> {
  const db = await createDb('pglite://memory');
  await migrate(db);
  await ensureFirms(db);
  await seedDemoFirm(db.forFirm(NB));
  await seedSecondFirm(db.forFirm(HL));
  return db;
}

/** Both firms plus their documents (Northbridge: filed library and three inbox documents; Harbourline: two). */
export async function demoDbWithDocuments(services: AppServices): Promise<Db> {
  const db = await demoDb();
  await seedDemoDocuments(db.forFirm(NB), services);
  await seedSecondFirmDocuments(db.forFirm(HL), services);
  return db;
}

/** An MCP client connected in-process to a server running as the given staff member. */
export async function connectAs(db: Db, email: string, services: AppServices = testServices()): Promise<Client> {
  const actor = await findActorByEmail(db, email);
  if (!actor) throw new Error(`No staff member ${email}`);
  const server = createMcpServer({ db: db.forFirm(actor.firmId), actor, services });
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
export const LENA = 'lena@harbourline.example'; // Harbourline partner
export const SAM = 'sam@harbourline.example'; // Harbourline assistant
