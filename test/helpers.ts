import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seedDemoFirm } from '../src/demo/seed.js';
import { findActorByEmail } from '../src/domain/staff.js';
import { createMcpServer } from '../src/mcp/server.js';

/** A fresh in-memory Postgres with the schema and demo firm loaded. */
export async function demoDb(): Promise<Db> {
  const db = await createDb('pglite://memory');
  await migrate(db);
  await seedDemoFirm(db);
  return db;
}

/** An MCP client connected in-process to a server running as the given staff member. */
export async function connectAs(db: Db, email: string): Promise<Client> {
  const actor = await findActorByEmail(db, email);
  if (!actor) throw new Error(`No staff member ${email}`);
  const server = createMcpServer({ db, actor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

export const MAYA = 'maya@northbridge.example'; // partner
export const TOM = 'tom@northbridge.example'; // assistant
