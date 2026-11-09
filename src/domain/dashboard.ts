import type { Db } from '../db/index.js';
import type { Actor } from './types.js';

export interface AuditRow {
  id: number;
  at: string;
  staff: { id: string; name: string } | null;
  tool: string;
  outcome: 'ok' | 'denied' | 'error';
  detail: string | null;
  durationMs: number | null;
  input: unknown;
}

/** The audit log for the dashboard. Partners see every row; assistants only their own, without internal details. */
export async function listAudit(
  db: Db,
  actor: Actor,
  options: { limit: number; before?: number; outcome?: string; tool?: string },
): Promise<{ rows: AuditRow[]; nextBefore: number | null; tools: string[] }> {
  const own = actor.role === 'partner' ? null : actor.staffId;
  const rows = await db.query<{
    id: number;
    at: string;
    staff_id: string | null;
    staff_name: string | null;
    tool: string;
    outcome: 'ok' | 'denied' | 'error';
    detail: string | null;
    duration_ms: number | null;
    input: unknown;
  }>(
    `select a.id, to_char(a.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at, a.staff_id, s.name as staff_name,
            a.tool, a.outcome, a.detail, a.duration_ms, a.input
     from audit_log a left join staff s on s.id = a.staff_id
     where ($1::text is null or a.staff_id = $1)
       and ($2::bigint is null or a.id < $2)
       and ($3::text is null or a.outcome = $3)
       and ($4::text is null or a.tool = $4)
     order by a.id desc limit $5`,
    [own, options.before ?? null, options.outcome ?? null, options.tool ?? null, options.limit + 1],
  );
  const tools = await db.query<{ tool: string }>(
    'select distinct tool from audit_log where ($1::text is null or staff_id = $1) order by tool',
    [own],
  );
  const page = rows.slice(0, options.limit);
  return {
    rows: page.map((r) => ({
      id: Number(r.id),
      at: r.at,
      staff: r.staff_id ? { id: r.staff_id, name: r.staff_name ?? r.staff_id } : null,
      tool: r.tool,
      outcome: r.outcome,
      // Details can name clients the caller isn't assigned to (match reasons, likely owners): partners only.
      detail: own === null ? r.detail : null,
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      input: r.input,
    })),
    nextBefore: rows.length > options.limit ? Number(page[page.length - 1]!.id) : null,
    tools: tools.map((t) => t.tool),
  };
}

export async function toolCallsToday(db: Db, actor: Actor): Promise<{ ok: number; denied: number; error: number }> {
  const rows = await db.query<{ outcome: 'ok' | 'denied' | 'error'; n: number }>(
    `select outcome, count(*)::int as n from audit_log
     where at >= date_trunc('day', now()) and ($1::text is null or staff_id = $1) group by outcome`,
    [actor.role === 'partner' ? null : actor.staffId],
  );
  const counts = { ok: 0, denied: 0, error: 0 };
  for (const r of rows) counts[r.outcome] = Number(r.n);
  return counts;
}

export async function countOpenItems(db: Db, allowed: string[] | 'all'): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    `select count(*)::int as n from open_items where status = 'open' and ($1::text[] is null or client_id = any($1::text[]))`,
    [allowed === 'all' ? null : allowed],
  );
  return Number(row?.n ?? 0);
}

export async function staffNames(db: Db): Promise<Map<string, string>> {
  const rows = await db.query<{ id: string; name: string }>('select id, name from staff');
  return new Map(rows.map((r) => [r.id, r.name]));
}
