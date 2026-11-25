import { randomBytes } from 'node:crypto';
import type { JobsConfig } from '../config.js';
import { firmOf, type Db } from '../db/index.js';

/**
 * A job queue in Postgres. One row per document; `step` is the last step completed, `status` where the job is:
 *   queued  → waiting (for the first try, the next step, or a retry whose backoff hasn't passed: `run_at`)
 *   running → claimed by a worker (`locked_by`, `locked_at`)
 *   done    → finished (the document was filed or sent to review)
 *   dead    → failed `max_attempts` times in a row: the dead-letter state; a partner can retry it
 *
 * Claiming is one statement: `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`. Concurrent workers
 * skip rows another transaction has locked, so a job is never taken twice; no Redis, no extra service.
 *
 * Firms: the queue is shared infrastructure, so claiming, advancing and failing run on the unscoped (owner) handle
 * by job id. Everything a job does to firm data runs on `db.forFirm(job.firmId)`. Enqueueing, listing and retrying
 * (dashboard) take a firm-scoped handle and only ever see that firm's jobs.
 */

export const STEPS = ['stored', 'text_extracted', 'embedded', 'fields_extracted', 'matched'] as const;
export type Step = (typeof STEPS)[number] | 'filed' | 'review';
export type JobStatus = 'queued' | 'running' | 'done' | 'dead';

export interface Job {
  id: number;
  firmId: string;
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
  /** Identifies this claim (not just the worker): only its holder may record the step. Empty unless claimed. */
  lock: string;
}

type Row = {
  id: number | string;
  firm_id: string;
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
  locked_by: string | null;
};

const COLUMNS = `id, firm_id, kind, batch_id, document_id, created_by, step, status, attempts, max_attempts, last_error, locked_by,
  to_char(run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as run_at,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at`;

const toJob = (r: Row): Job => ({
  id: Number(r.id),
  firmId: r.firm_id,
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
  lock: r.locked_by ?? '',
});

export async function getJob(db: Db, id: number): Promise<Job | null> {
  const [row] = await db.query<Row>(`select ${COLUMNS} from jobs where id = $1 and firm_id = $2`, [id, firmOf(db)]);
  return row ? toJob(row) : null;
}

export async function findJobByKey(db: Db, idempotencyKey: string): Promise<Job | null> {
  const [row] = await db.query<Row>(`select ${COLUMNS} from jobs where idempotency_key = $1 and firm_id = $2`, [
    idempotencyKey,
    firmOf(db),
  ]);
  return row ? toJob(row) : null;
}

export function workerId(): string {
  return `w_${process.pid}_${randomBytes(3).toString('hex')}`;
}

/**
 * Takes the next job that is due, or one whose worker stopped answering (`running` past the stuck timeout), and
 * counts the attempt. Every claim gets its own lock token, so a loop whose job was taken over (even by another loop of the
 * same worker) can no longer record anything. Returns null when nothing is due.
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
    [`${worker}:${randomBytes(6).toString('hex')}`, config.stuckSeconds],
  );
  return row ? toJob(row) : null;
}

/** Still working on it: pushes back the moment the job counts as stuck. */
export async function heartbeat(db: Db, job: Job): Promise<void> {
  await db.query(`update jobs set locked_at = now() where id = $1 and locked_by = $2 and status = 'running'`, [
    job.id,
    job.lock,
  ]);
}

/** Milliseconds until something can be claimed (a retry, or a stuck job); null when nothing is pending. */
export async function nextDueMs(db: Db, config: Pick<JobsConfig, 'stuckSeconds'>): Promise<number | null> {
  const [row] = await db.query<{ ms: number | null }>(
    `select (extract(epoch from min(case when status = 'queued' then run_at
                                         else locked_at + make_interval(secs => $1) end) - now()) * 1000)::float8 as ms
     from jobs where status in ('queued', 'running')`,
    [config.stuckSeconds],
  );
  return row?.ms === null || row?.ms === undefined ? null : Math.max(0, Number(row.ms));
}

/** What every job audit row holds: ids only. */
const auditInput = (job: Job) =>
  JSON.stringify({ jobId: job.id, documentId: job.documentId, batchId: job.batchId, attempt: job.attempts });

/**
 * A step succeeded: record it and queue the next one (attempts start again), or finish the job, with its audit row in
 * the same statement. False: the job was reclaimed as stuck by another worker meanwhile, which now owns it.
 */
export async function advance(
  db: Db,
  job: Job,
  step: Step,
  done: boolean,
  options: { detail?: string; auditAs?: string } = {},
): Promise<boolean> {
  const rows = await db.query(
    `with j as (
       update jobs set step = $3, status = $4, attempts = 0, last_error = null, run_at = now(), locked_by = null,
              locked_at = null, updated_at = now(), finished_at = case when $4 = 'done' then now() end
       where id = $1 and locked_by = $2 and status = 'running' returning id, firm_id, created_by
     ), a as (
       insert into audit_log (firm_id, staff_id, tool, input, outcome, detail, duration_ms)
       select firm_id, created_by, $5, $6::jsonb, 'ok', $7, 0 from j
     )
     select id from j`,
    [
      job.id,
      job.lock,
      step,
      done ? 'done' : 'queued',
      `job:${options.auditAs ?? step}`,
      auditInput(job),
      options.detail ?? null,
    ],
  );
  return rows.length === 1;
}

/**
 * Files the job's document, writes the CRM note and the audit row and records the step, in one statement, only while
 * this worker still owns the job and the document is still `processing`: a crash or a second worker can't leave a
 * document filed without its job knowing, or file it twice. The job stays queued for one more step (rebuilding the
 * document's search passages, now that its client and title are known). `db` is scoped to the job's firm.
 */
export async function completeFiling(
  db: Db,
  job: Job,
  input: {
    clientId: string;
    taxYear: number | null;
    docType: string | null;
    title: string;
    note: string;
    detail: string;
  },
): Promise<boolean> {
  const rows = await db.query(
    `with mine as (
       select id, document_id, created_by from jobs
       where id = $1 and firm_id = $2 and locked_by = $3 and status = 'running' for update
     ), d as (
       update documents set client_id = $4, tax_year = $5, doc_type = $6, title = $7, status = 'filed',
              filed_at = now(), filed_by = mine.created_by, review_reason = null,
              content_version = content_version + 1
       from mine where documents.id = mine.document_id and documents.firm_id = $2 and documents.status = 'processing'
       returning documents.id
     ), n as (
       insert into notes (id, client_id, author_id, body, kind, firm_id)
       select $8, $4, mine.created_by, $9, 'filing', $2 from mine, d
     ), a as (
       insert into audit_log (firm_id, staff_id, tool, input, outcome, detail, duration_ms)
       select $2, mine.created_by, 'job:filed', $10::jsonb, 'ok', $11, 0 from mine, d
     )
     update jobs set step = 'filed', status = 'queued', attempts = 0, last_error = null, run_at = now(),
            locked_by = null, locked_at = null, updated_at = now()
     from d where jobs.id = $1 and jobs.firm_id = $2 returning jobs.id`,
    [
      job.id,
      firmOf(db),
      job.lock,
      input.clientId,
      input.taxYear,
      input.docType,
      input.title,
      `nt_${randomBytes(5).toString('hex')}`,
      input.note,
      auditInput(job),
      input.detail,
    ],
  );
  return rows.length === 1;
}

/** Sends the job's document to review and finishes the job, with its audit row, in one statement (see above). */
export async function completeReview(db: Db, job: Job, reason: string): Promise<boolean> {
  const rows = await db.query(
    `with mine as (
       select id, document_id, created_by from jobs
       where id = $1 and firm_id = $2 and locked_by = $3 and status = 'running' for update
     ), d as (
       update documents set status = 'review', review_reason = $4, sent_to_review_by = mine.created_by,
              sent_to_review_at = now()
       from mine where documents.id = mine.document_id and documents.firm_id = $2 and documents.status = 'processing'
       returning documents.id
     ), a as (
       insert into audit_log (firm_id, staff_id, tool, input, outcome, detail, duration_ms)
       select $2, mine.created_by, 'job:review', $5::jsonb, 'ok', $4, 0 from mine, d
     )
     update jobs set step = 'review', status = 'done', attempts = 0, last_error = null, locked_by = null,
            locked_at = null, updated_at = now(), finished_at = now()
     from d where jobs.id = $1 and jobs.firm_id = $2 returning jobs.id`,
    [job.id, firmOf(db), job.lock, reason, auditInput(job)],
  );
  return rows.length === 1;
}

/** Exponential backoff: base, 2×base, 4×base… capped at 10 minutes. */
export function backoffMs(attempts: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempts - 1), 600_000);
}

/**
 * A step failed: retry later, or dead-letter the job when it has used all its attempts. Dead-lettering hands the
 * document back to the inbox (people take over) in the same statement, along with the audit row.
 */
export async function fail(
  db: Db,
  job: Job,
  error: string,
  config: Pick<JobsConfig, 'backoffMs'>,
  options: { denied?: boolean } = {},
): Promise<'retry' | 'dead' | 'lost'> {
  const dead = job.attempts >= job.maxAttempts;
  const rows = await db.query(
    `with j as (
       update jobs set status = $3, last_error = $4, run_at = now() + make_interval(secs => $5), locked_by = null,
              locked_at = null, updated_at = now()
       where id = $1 and locked_by = $2 and status = 'running' returning id, firm_id, document_id, created_by, status
     ), d as (
       update documents set status = 'inbox' from j
       where j.status = 'dead' and documents.id = j.document_id and documents.firm_id = j.firm_id
         and documents.status = 'processing'
     ), a as (
       insert into audit_log (firm_id, staff_id, tool, input, outcome, detail, duration_ms)
       select firm_id, created_by, $6, $7::jsonb, $8, $4, 0 from j
     )
     select id from j`,
    [
      job.id,
      job.lock,
      dead ? 'dead' : 'queued',
      error.slice(0, 500),
      backoffMs(job.attempts, config.backoffMs) / 1000,
      dead ? 'job:dead_letter' : 'job:retry',
      auditInput(job),
      options.denied ? 'denied' : 'error',
    ],
  );
  if (rows.length === 0) return 'lost';
  return dead ? 'dead' : 'retry';
}

/**
 * Dead-letter retry: the job starts again from its last completed step with fresh attempts, and takes its document
 * back from the inbox in the same statement. Null when someone has handled the document meanwhile.
 */
export async function retryDead(db: Db, id: number): Promise<Job | null> {
  const [row] = await db.query<Row>(
    `with dead as (
       select id, document_id, step from jobs where id = $1 and firm_id = $2 and status = 'dead' for update
     ), d as (
       update documents set status = case when documents.status = 'filed' then 'filed' else 'processing' end
       from dead where documents.id = dead.document_id and documents.firm_id = $2
         and (documents.status = 'inbox' or (dead.step = 'filed' and documents.status = 'filed'))
       returning documents.id
     )
     update jobs set status = 'queued', attempts = 0, run_at = now(), last_error = null, updated_at = now()
     where id in (select dead.id from dead join d on d.id = dead.document_id) and firm_id = $2
     returning ${COLUMNS}`,
    [id, firmOf(db)],
  );
  return row ? toJob(row) : null;
}

export async function listJobs(
  db: Db,
  filter: { batchId?: string; status?: JobStatus; limit?: number },
): Promise<Job[]> {
  const rows = await db.query<Row>(
    `select ${COLUMNS} from jobs
     where firm_id = $4 and ($1::text is null or batch_id = $1) and ($2::text is null or status = $2)
     order by id desc limit $3`,
    [filter.batchId ?? null, filter.status ?? null, filter.limit ?? 100, firmOf(db)],
  );
  return rows.map(toJob);
}

export async function createBatch(db: Db, createdBy: string, total: number): Promise<string> {
  const id = `bat_${randomBytes(6).toString('hex')}`;
  await db.query('insert into batches (id, created_by, total, firm_id) values ($1, $2, $3, $4)', [
    id,
    createdBy,
    total,
    firmOf(db),
  ]);
  return id;
}

export async function getBatch(
  db: Db,
  id: string,
): Promise<{ id: string; createdBy: string; createdAt: string; total: number } | null> {
  const [row] = await db.query<{ id: string; created_by: string; created_at: string; total: number }>(
    `select id, created_by, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at, total
     from batches where id = $1 and firm_id = $2`,
    [id, firmOf(db)],
  );
  return row ? { id: row.id, createdBy: row.created_by, createdAt: row.created_at, total: Number(row.total) } : null;
}
