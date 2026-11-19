import { randomBytes } from 'node:crypto';
import type { JobsConfig } from '../config.js';
import type { Db } from '../db/index.js';

/**
 * A job queue in Postgres. One row per document; `step` is the last step completed, `status` where the job is:
 *   queued  → waiting (for the first try, the next step, or a retry whose backoff hasn't passed: `run_at`)
 *   running → claimed by a worker (`locked_by`, `locked_at`)
 *   done    → finished (the document was filed or sent to review)
 *   dead    → failed `max_attempts` times in a row: the dead-letter state; a partner can retry it
 *
 * Claiming is one statement: `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`. Concurrent workers
 * skip rows another transaction has locked, so a job is never taken twice; no Redis, no extra service.
 */

export const STEPS = ['stored', 'text_extracted', 'embedded', 'fields_extracted', 'matched'] as const;
export type Step = (typeof STEPS)[number] | 'filed' | 'review';
export type JobStatus = 'queued' | 'running' | 'done' | 'dead';

export interface Job {
  id: number;
  kind: 'intake';
  batchId: string | null;
  documentId: string;
  createdBy: string;
  step: Step;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: string;
  updatedAt: string;
}

type Row = {
  id: number | string;
  kind: 'intake';
  batch_id: string | null;
  document_id: string;
  created_by: string;
  step: Step;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_at: string;
  updated_at: string;
};

const COLUMNS = `id, kind, batch_id, document_id, created_by, step, status, attempts, max_attempts, last_error,
  to_char(run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as run_at,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at`;

const toJob = (r: Row): Job => ({
  id: Number(r.id),
  kind: r.kind,
  batchId: r.batch_id,
  documentId: r.document_id,
  createdBy: r.created_by,
  step: r.step,
  status: r.status,
  attempts: Number(r.attempts),
  maxAttempts: Number(r.max_attempts),
  lastError: r.last_error,
  runAt: r.run_at,
  updatedAt: r.updated_at,
});

export async function getJob(db: Db, id: number): Promise<Job | null> {
  const [row] = await db.query<Row>(`select ${COLUMNS} from jobs where id = $1`, [id]);
  return row ? toJob(row) : null;
}

export async function findJobByKey(db: Db, idempotencyKey: string): Promise<Job | null> {
  const [row] = await db.query<Row>(`select ${COLUMNS} from jobs where idempotency_key = $1`, [idempotencyKey]);
  return row ? toJob(row) : null;
}

/**
 * Adds a job. With an idempotency key, a second enqueue with the same key returns the first job instead of adding
 * one (a retried upload request can't process a document twice).
 */
export async function enqueue(
  db: Db,
  input: { documentId: string; createdBy: string; batchId?: string | null; idempotencyKey?: string | null },
  config: Pick<JobsConfig, 'maxAttempts'>,
): Promise<{ job: Job; created: boolean }> {
  const [row] = await db.query<Row>(
    `insert into jobs (kind, batch_id, document_id, created_by, idempotency_key, max_attempts)
     values ('intake', $1, $2, $3, $4, $5)
     on conflict (idempotency_key) do nothing
     returning ${COLUMNS}`,
    [input.batchId ?? null, input.documentId, input.createdBy, input.idempotencyKey ?? null, config.maxAttempts],
  );
  if (row) return { job: toJob(row), created: true };
  const existing = await findJobByKey(db, input.idempotencyKey!);
  if (!existing) throw new Error('Job vanished after an idempotency conflict');
  return { job: existing, created: false };
}

export function workerId(): string {
  return `w_${process.pid}_${randomBytes(3).toString('hex')}`;
}

/**
 * Takes the next job that is due, or one whose worker stopped answering (`running` past the stuck timeout), and
 * counts the attempt. Returns null when nothing is due.
 */
export async function claimNext(db: Db, worker: string, config: Pick<JobsConfig, 'stuckSeconds'>): Promise<Job | null> {
  const [row] = await db.query<Row>(
    `update jobs set status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1, updated_at = now()
     where id = (
       select id from jobs
       where (status = 'queued' and run_at <= now())
          or (status = 'running' and locked_at < now() - make_interval(secs => $2))
       order by run_at, id
       for update skip locked
       limit 1)
     returning ${COLUMNS}`,
    [worker, config.stuckSeconds],
  );
  return row ? toJob(row) : null;
}

/** A step succeeded: record it and queue the next one (attempts start again), or finish the job. */
export async function advance(db: Db, job: Job, worker: string, step: Step, done: boolean): Promise<boolean> {
  const rows = await db.query(
    `update jobs set step = $3, status = $4, attempts = 0, last_error = null, run_at = now(), locked_by = null,
            locked_at = null, updated_at = now(), finished_at = case when $4 = 'done' then now() end
     where id = $1 and locked_by = $2 and status = 'running' returning id`,
    [job.id, worker, step, done ? 'done' : 'queued'],
  );
  // No row: the job was reclaimed as stuck by another worker meanwhile; that worker now owns it.
  return rows.length === 1;
}

/** Exponential backoff: base, 2×base, 4×base… capped at 10 minutes. */
export function backoffMs(attempts: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempts - 1), 600_000);
}

/** A step failed: retry later, or dead-letter the job when it has used all its attempts. */
export async function fail(
  db: Db,
  job: Job,
  worker: string,
  error: string,
  config: Pick<JobsConfig, 'backoffMs'>,
): Promise<'retry' | 'dead' | 'lost'> {
  const dead = job.attempts >= job.maxAttempts;
  const rows = await db.query(
    `update jobs set status = $3, last_error = $4, run_at = now() + make_interval(secs => $5), locked_by = null,
            locked_at = null, updated_at = now()
     where id = $1 and locked_by = $2 and status = 'running' returning id`,
    [job.id, worker, dead ? 'dead' : 'queued', error.slice(0, 500), backoffMs(job.attempts, config.backoffMs) / 1000],
  );
  if (rows.length === 0) return 'lost';
  return dead ? 'dead' : 'retry';
}

/** Dead-letter retry: the job starts again from its last completed step with fresh attempts. */
export async function retryDead(db: Db, id: number): Promise<Job | null> {
  const [row] = await db.query<Row>(
    `update jobs set status = 'queued', attempts = 0, run_at = now(), last_error = null, updated_at = now()
     where id = $1 and status = 'dead' returning ${COLUMNS}`,
    [id],
  );
  return row ? toJob(row) : null;
}

export async function listJobs(
  db: Db,
  filter: { batchId?: string; status?: JobStatus; limit?: number },
): Promise<Job[]> {
  const rows = await db.query<Row>(
    `select ${COLUMNS} from jobs
     where ($1::text is null or batch_id = $1) and ($2::text is null or status = $2)
     order by id desc limit $3`,
    [filter.batchId ?? null, filter.status ?? null, filter.limit ?? 100],
  );
  return rows.map(toJob);
}

export async function createBatch(db: Db, createdBy: string, total: number): Promise<string> {
  const id = `bat_${randomBytes(6).toString('hex')}`;
  await db.query('insert into batches (id, created_by, total) values ($1, $2, $3)', [id, createdBy, total]);
  return id;
}

export async function getBatch(
  db: Db,
  id: string,
): Promise<{ id: string; createdBy: string; createdAt: string; total: number } | null> {
  const [row] = await db.query<{ id: string; created_by: string; created_at: string; total: number }>(
    `select id, created_by, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at, total
     from batches where id = $1`,
    [id],
  );
  return row ? { id: row.id, createdBy: row.created_by, createdAt: row.created_at, total: Number(row.total) } : null;
}
