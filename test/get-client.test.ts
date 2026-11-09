import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.js';
import { connectAs, demoDb, MAYA, TOM } from './helpers.js';

type GetClientResult = {
  status: 'found' | 'ambiguous' | 'not_found' | 'denied';
  message: string;
  client?: { id: string; name: string; assignedStaff: { name: string }[] };
  openItems?: { description: string; status: string }[];
  candidates?: { id: string; name: string }[];
};

async function getClient(client: Client, query: string) {
  const result = await client.callTool({ name: 'get_client', arguments: { client: query } });
  return { result, data: result.structuredContent as GetClientResult };
}

async function lastAudit(db: Db) {
  const [row] = await db.query<{ staff_id: string; tool: string; outcome: string; input: unknown }>(
    'select staff_id, tool, outcome, input from audit_log order by id desc limit 1',
  );
  return row;
}

describe('get_client', () => {
  let db: Db;
  let maya: Client;
  let tom: Client;

  beforeAll(async () => {
    db = await demoDb();
    maya = await connectAs(db, MAYA);
    tom = await connectAs(db, TOM);
  });

  afterAll(async () => {
    await maya.close();
    await tom.close();
    await db.close();
  });

  it('is advertised as read-only with an output schema', async () => {
    const { tools } = await maya.listTools();
    const tool = tools.find((t) => t.name === 'get_client');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.outputSchema).toBeDefined();
  });

  it('returns the full profile for an exact name', async () => {
    const { data } = await getClient(maya, 'acme ltd');
    expect(data.status).toBe('found');
    expect(data.client?.id).toBe('cl_acme');
    expect(data.client?.assignedStaff.map((s) => s.name)).toContain('Tom Lindqvist');
    expect(data.openItems?.some((o) => o.description.includes('Q4 payroll'))).toBe(true);
  });

  it('asks instead of guessing when a name matches several clients', async () => {
    const { data } = await getClient(maya, 'Acme');
    expect(data.status).toBe('ambiguous');
    expect(data.candidates?.map((c) => c.id).sort()).toEqual(['cl_acme', 'cl_acme_labs']);
  });

  it('only offers an assistant the clients assigned to them', async () => {
    // Tom is assigned to Acme Ltd but not Acme Labs, so "Acme" resolves to one client for him.
    const { data } = await getClient(tom, 'Acme');
    expect(data.status).toBe('found');
    expect(data.client?.id).toBe('cl_acme');
  });

  it('refuses an unassigned client and logs the denial', async () => {
    const { result, data } = await getClient(tom, 'Lakeside Dental Group');
    expect(data.status).toBe('denied');
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).not.toContain('Noah Bell'); // no client data leaks
    const audit = await lastAudit(db);
    expect(audit).toMatchObject({ staff_id: 'st_tom', tool: 'get_client', outcome: 'denied' });
  });

  it('reports a missing client clearly', async () => {
    const { data } = await getClient(maya, 'Nonexistent Holdings');
    expect(data.status).toBe('not_found');
  });

  it('writes one audit row per call', async () => {
    const before = await db.query<{ n: number }>('select count(*)::int as n from audit_log');
    await getClient(maya, 'cl_kim');
    const after = await db.query<{ n: number }>('select count(*)::int as n from audit_log');
    expect(Number(after[0]!.n) - Number(before[0]!.n)).toBe(1);
    expect(await lastAudit(db)).toMatchObject({ staff_id: 'st_maya', outcome: 'ok', input: { client: 'cl_kim' } });
  });
});
