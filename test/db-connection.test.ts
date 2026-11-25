import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { pgScoped } from '../src/db/index.js';

/** A pool with one connection that drops (as `pg` reports it: an `error` event and a failed query) at the nth query. */
function droppingPool(at: number) {
  const released: unknown[] = [];
  let n = 0;
  let down = false;
  const conn = Object.assign(new EventEmitter(), {
    query: async () => {
      if (++n === at) {
        down = true;
        conn.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      }
      if (down) throw new Error('Connection terminated unexpectedly');
      return { rows: [{ ok: 1 }] };
    },
    release: (destroy?: unknown) => void released.push(destroy),
  });
  return { pool: { connect: async () => conn } as unknown as Pick<pg.Pool, 'connect'>, conn, released };
}

describe('a database connection that drops in the middle of a scoped query', () => {
  it.each([1, 2, 3, 4])('fails that query (%i of 4) and nothing else; the connection is thrown away', async (at) => {
    const { pool, conn, released } = droppingPool(at);
    // Without a listener, the event itself would be thrown (and end the process): seen here as the wrong error.
    await expect(pgScoped(pool)('firm_northbridge', 'select 1', [])).rejects.toThrow(
      'Connection terminated unexpectedly',
    );
    expect(released).toEqual([true]);
    expect(conn.listenerCount('error')).toBe(0);
  });

  it('returns a healthy connection to the pool', async () => {
    const { pool, conn, released } = droppingPool(99);
    expect(await pgScoped(pool)('firm_northbridge', 'select 1', [])).toEqual([{ ok: 1 }]);
    expect(released).toEqual([undefined]);
    expect(conn.listenerCount('error')).toBe(0);
  });
});
