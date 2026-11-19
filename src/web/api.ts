import { inferTaxYear } from '../ai/extraction.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { accessibleClientIds, canAccessClient, partitionByAccess } from '../domain/access.js';
import { recordAudit } from '../domain/audit.js';
import { countOpenItems, listAudit, staffNames, toolCallsToday } from '../domain/dashboard.js';
import {
  documentCounts,
  getDocument,
  ingestDocument,
  setProcessing,
  listDocumentsByStatus,
  markFiled,
  retitleAndReindex,
  MAX_UPLOAD_BYTES,
  SUPPORTED_TYPES,
  type DocumentRecord,
} from '../domain/documents.js';
import { addNote } from '../domain/open-items.js';
import { findActorByEmail, findActorById } from '../domain/staff.js';
import type { Actor } from '../domain/types.js';
import { ensureMatch } from '../domain/intake.js';
import { canSeeDocument } from '../mcp/document-access.js';
import { createBatch, enqueue, findJobByKey, getBatch, getJob, listJobs, retryDead } from '../jobs/queue.js';
import type { AppServices } from '../services.js';
import { readSession } from './session.js';

const DEV_USER_HEADER = 'x-clientdesk-user';
export const CSRF_HEADER = 'x-clientdesk-csrf';

type Deps = { db: Db; config: Config; services: AppServices; projectRoot: string };

declare module 'express-serve-static-core' {
  interface Request {
    staff?: Actor;
  }
}

const error = (res: Response, status: number, message: string) => res.status(status).json({ error: message });

/** Sends a stored document with headers that keep it private and un-sniffable. */
export async function sendDocumentFile(res: Response, services: AppServices, doc: DocumentRecord): Promise<void> {
  const bytes = doc.storageKey ? await services.files.get(doc.storageKey) : null;
  if (!bytes) {
    error(res, 404, 'File not found');
    return;
  }
  const type =
    doc.mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : (doc.mimeType ?? 'application/octet-stream');
  const filename = (doc.sourceFilename ?? `${doc.id}.${SUPPORTED_TYPES[doc.mimeType ?? ''] ?? 'bin'}`).replace(
    /[^\w.-]+/g,
    '_',
  );
  res
    .status(200)
    .set({
      'content-type': type,
      'content-disposition': `inline; filename="${filename}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    })
    .send(Buffer.from(bytes));
}

/** Names a refused write for the audit log, e.g. `resolve_review`. */
function writeActionName(path: string): string {
  if (/^\/review\/[^/]+\/resolve$/.test(path)) return 'resolve_review';
  if (path === '/documents') return 'upload';
  if (path === '/batches') return 'create_batch';
  if (/^\/batches\/[^/]+\/files$/.test(path)) return 'batch_upload';
  if (/^\/jobs\/[^/]+\/retry$/.test(path)) return 'retry_job';
  return 'write';
}

/**
 * The staff member behind a dashboard request. A demo session is honoured only while DEMO_LOGIN is on, and is always
 * read-only whatever the staff row says.
 */
export async function resolveDashboardActor(req: Request, db: Db, config: Config): Promise<Actor | null> {
  const session = await readSession(req, config.sessionSecret);
  if (session && !(session.demo && !config.demoLogin)) {
    const actor = await findActorById(db, session.staffId);
    if (actor) return session.demo ? { ...actor, readOnly: true } : actor;
  }
  if (config.authMode === 'dev') return findActorByEmail(db, req.header(DEV_USER_HEADER) ?? config.devUser);
  return null;
}

export function createApiRouter(deps: Deps): Router {
  const { db, config, services } = deps;
  const router = Router();

  // Who is calling: a session cookie (dashboard sign-in or "Try the demo") in either auth mode, else, in dev mode
  // only, the dev header.
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = await resolveDashboardActor(req, db, config);
      if (!actor) return error(res, 401, 'Not signed in');
      req.staff = actor;
      // State-changing requests must carry a custom header: a cross-site form or image can't add one.
      if (req.method !== 'GET' && req.header(CSRF_HEADER) !== '1') return error(res, 403, 'Missing CSRF header');
      // Read-only (demo) sessions: every write route is refused here, before its body is read, so routes added later
      // inherit the rule.
      if (actor.readOnly && req.method !== 'GET' && req.method !== 'HEAD') {
        await recordAudit(db, {
          staffId: actor.staffId,
          tool: `dashboard:${writeActionName(req.path)}`,
          input: { method: req.method, path: req.path.slice(0, 200) },
          outcome: 'denied',
          detail: 'read-only session',
          durationMs: 0,
        });
        return error(res, 403, 'This is a read-only demo session, so nothing can be changed.');
      }
      return next();
    } catch (err) {
      return next(err);
    }
  });

  const audit = (actor: Actor, tool: string, input: unknown, outcome: 'ok' | 'denied' | 'error', detail?: string) =>
    recordAudit(db, { staffId: actor.staffId, tool, input, outcome, detail, durationMs: 0 });

  router.get('/me', (req, res) => {
    const a = req.staff!;
    res.json({
      staffId: a.staffId,
      name: a.name,
      email: a.email,
      role: a.role,
      readOnly: a.readOnly,
      authMode: config.authMode,
    });
  });

  router.get('/staff', async (_req, res) => {
    if (config.authMode !== 'dev') return error(res, 404, 'Not available');
    // The demo visitor isn't a person to switch to; it is reached through "Try the demo".
    const staff = await db.query<{ email: string; name: string; role: string }>(
      'select email, name, role from staff where not read_only order by role desc, name',
    );
    return res.json({ staff });
  });

  router.get('/stats', async (req, res) => {
    const actor = req.staff!;
    res.json({
      documents: await documentCounts(db),
      toolCallsToday: await toolCallsToday(db, actor),
      openItems: await countOpenItems(db, await accessibleClientIds(db, actor)),
    });
  });

  router.get('/audit', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const before = req.query.before ? Number(req.query.before) : undefined;
    const outcome = ['ok', 'denied', 'error'].includes(String(req.query.outcome))
      ? String(req.query.outcome)
      : undefined;
    const tool = typeof req.query.tool === 'string' && req.query.tool ? req.query.tool.slice(0, 100) : undefined;
    res.json(
      await listAudit(db, req.staff!, { limit, before: Number.isFinite(before) ? before : undefined, outcome, tool }),
    );
  });

  router.get('/inbox', async (_req, res) => {
    const names = await staffNames(db);
    const docs = await listDocumentsByStatus(db, 'inbox', 100);
    res.json({
      items: docs.map((d) => ({
        id: d.id,
        title: d.title,
        filename: d.sourceFilename,
        receivedAt: d.receivedAt,
        uploadedBy: d.uploadedBy ? { name: names.get(d.uploadedBy) ?? d.uploadedBy } : null,
        pageCount: d.pageCount,
      })),
    });
  });

  router.get('/review', async (req, res) => {
    const actor = req.staff!;
    const names = await staffNames(db);
    const rows = await db.query<{ id: string; sent_to_review_by: string | null }>(
      `select id, sent_to_review_by from documents where status = 'review' order by sent_to_review_at desc nulls last`,
    );
    const items = [];
    for (const row of rows) {
      // Partners see the whole queue; assistants see what they sent.
      if (actor.role !== 'partner' && row.sent_to_review_by !== actor.staffId) continue;
      const doc = (await getDocument(db, row.id))!;
      const candidates = doc.match?.candidates ?? [];
      const { allowed } = await partitionByAccess(
        db,
        actor,
        candidates.map((c) => c.clientId),
      );
      const contentsVisible = (await canSeeDocument({ db, actor }, doc, doc.match)).allowed;
      items.push({
        id: doc.id,
        title: doc.title,
        filename: doc.sourceFilename,
        receivedAt: doc.receivedAt,
        reviewReason: doc.reviewReason,
        sentBy: row.sent_to_review_by ? { name: names.get(row.sent_to_review_by) ?? row.sent_to_review_by } : null,
        docType: doc.extraction?.docType ?? null,
        extraction:
          contentsVisible && doc.extraction
            ? { docType: doc.extraction.docType, fields: doc.extraction.fields, model: doc.extraction.model }
            : null,
        candidates: candidates.filter((c) => allowed.has(c.clientId)),
      });
    }
    res.json({ items });
  });

  router.post('/review/:id/resolve', express.json({ limit: '10kb' }), async (req, res) => {
    const actor = req.staff!;
    const input = { documentId: req.params.id, clientId: req.body?.clientId, taxYear: req.body?.taxYear };
    if (actor.role !== 'partner') {
      await audit(actor, 'dashboard:resolve_review', input, 'denied', 'partners only');
      return error(res, 403, 'Only partners can resolve reviews');
    }
    if (typeof input.clientId !== 'string' || !(await canAccessClient(db, actor, input.clientId))) {
      return error(res, 400, 'Choose a client');
    }
    const [client] = await db.query<{ name: string }>('select name from clients where id = $1', [input.clientId]);
    if (!client) return error(res, 400, 'Unknown client');
    const doc = await getDocument(db, String(req.params.id));
    if (!doc || doc.status !== 'review') return error(res, 404, 'Not in the review queue');
    const taxYear =
      Number.isInteger(input.taxYear) && input.taxYear >= 2000 && input.taxYear <= 2100
        ? (input.taxYear as number)
        : doc.extraction
          ? inferTaxYear(doc.extraction)
          : null;
    const docType = doc.extraction?.docType ?? null;
    if (!(await markFiled(db, { id: doc.id, clientId: input.clientId, taxYear, docType, staffId: actor.staffId }))) {
      return error(res, 409, 'The document changed; reload the queue');
    }
    await retitleAndReindex(db, services.embedder, doc.id, doc.extraction);
    await addNote(db, {
      clientId: input.clientId,
      authorId: actor.staffId,
      body: `Filed "${doc.title}" from the review queue (reason: ${doc.reviewReason ?? 'n/a'}).`,
      kind: 'filing',
    });
    await audit(actor, 'dashboard:resolve_review', input, 'ok', `filed to ${input.clientId}`);
    return res.json({ ok: true });
  });

  router.post(
    '/documents',
    express.raw({ type: Object.keys(SUPPORTED_TYPES), limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      const actor = req.staff!;
      const mimeType = String(req.headers['content-type'] ?? '')
        .split(';')[0]!
        .trim();
      if (!SUPPORTED_TYPES[mimeType] || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        return error(res, 415, 'Upload a PDF or a .txt file');
      }
      const filename = String(req.header('x-filename') ?? '')
        .replace(/[^\w.\- ]+/g, '_')
        .slice(0, 120);
      try {
        const result = await ingestDocument(db, services, {
          bytes: new Uint8Array(req.body),
          mimeType,
          filename: filename || null,
          uploadedBy: actor.staffId,
        });
        const doc = await getDocument(db, result.id);
        await audit(actor, 'dashboard:upload', { filename, bytes: req.body.length }, 'ok', result.id);
        return res.json({ id: result.id, title: doc?.title ?? filename, duplicate: result.duplicate });
      } catch (err) {
        await audit(actor, 'dashboard:upload', { filename }, 'error', err instanceof Error ? err.message : String(err));
        return error(res, 400, 'Could not read that file');
      }
    },
  );

  // ---------- batch intake (partners only) ----------

  const partnersOnly = async (req: Request, res: Response, action: string, input: unknown): Promise<boolean> => {
    const actor = req.staff!;
    if (actor.role === 'partner') return true;
    await audit(actor, `dashboard:${action}`, input, 'denied', 'partners only');
    error(res, 403, 'Only partners can use batch intake');
    return false;
  };

  router.post('/batches', express.json({ limit: '1kb' }), async (req, res) => {
    const total = Number(req.body?.total);
    if (!(await partnersOnly(req, res, 'create_batch', { total }))) return;
    if (!Number.isInteger(total) || total < 1 || total > 25) return error(res, 400, 'A batch holds 1 to 25 files');
    const id = await createBatch(db, req.staff!.staffId, total);
    await audit(req.staff!, 'dashboard:create_batch', { total }, 'ok', id);
    return res.json({ id });
  });

  router.post(
    '/batches/:id/files',
    express.raw({ type: Object.keys(SUPPORTED_TYPES), limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      const actor = req.staff!;
      const batchId = String(req.params.id);
      const filename = String(req.header('x-filename') ?? '')
        .replace(/[^\w.\- ]+/g, '_')
        .slice(0, 120);
      const input = { batchId, filename };
      if (!(await partnersOnly(req, res, 'batch_upload', input))) return;
      const batch = await getBatch(db, batchId);
      if (!batch || batch.createdBy !== actor.staffId) return error(res, 404, 'No such batch');
      const mimeType = String(req.headers['content-type'] ?? '')
        .split(';')[0]!
        .trim();
      if (!SUPPORTED_TYPES[mimeType] || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        return error(res, 415, 'Upload a PDF or a .txt file');
      }
      // The same Idempotency-Key from the same person in the same batch returns the first result: a retried
      // request never processes a document twice.
      const rawKey = req.header('idempotency-key');
      const key = rawKey && /^[\w-]{8,100}$/.test(rawKey) ? `${actor.staffId}:${batchId}:${rawKey}` : null;
      if (rawKey && !key) return error(res, 400, 'Idempotency-Key must be 8 to 100 letters, digits, - or _');
      const [{ n } = { n: 0 }] = await db.query<{ n: number }>(
        'select count(*)::int as n from jobs where batch_id = $1',
        [batchId],
      );
      try {
        const existing = key ? await findJobByKey(db, key) : null;
        if (existing) return res.json({ documentId: existing.documentId, jobId: existing.id, duplicate: false });
        if (Number(n) >= batch.total) return error(res, 409, 'This batch already has all its files');
        const result = await ingestDocument(db, services, {
          bytes: new Uint8Array(req.body),
          mimeType,
          filename: filename || null,
          uploadedBy: actor.staffId,
          deferProcessing: true,
        });
        if (result.duplicate) {
          await audit(actor, 'dashboard:batch_upload', input, 'ok', `duplicate of ${result.id}`);
          return res.json({ documentId: result.id, jobId: null, duplicate: true });
        }
        const { job } = await enqueue(
          db,
          { documentId: result.id, createdBy: actor.staffId, batchId, idempotencyKey: key },
          config.jobs,
        );
        await audit(actor, 'dashboard:batch_upload', input, 'ok', `${result.id} job ${job.id}`);
        return res.json({ documentId: result.id, jobId: job.id, duplicate: false });
      } catch (err) {
        await audit(actor, 'dashboard:batch_upload', input, 'error', err instanceof Error ? err.message : String(err));
        return error(res, 400, 'Could not store that file');
      }
    },
  );

  const jobView = async (jobs: Awaited<ReturnType<typeof listJobs>>) => {
    const docs = await Promise.all(jobs.map((j) => getDocument(db, j.documentId)));
    return jobs.map((j, i) => {
      const d = docs[i];
      return {
        jobId: j.id,
        documentId: j.documentId,
        title: d?.title ?? j.documentId,
        filename: d?.sourceFilename ?? null,
        step: j.step,
        status: j.status,
        attempts: j.attempts,
        maxAttempts: j.maxAttempts,
        lastError: j.lastError,
        nextTryAt: j.status === 'queued' && j.attempts > 0 ? j.runAt : null,
        updatedAt: j.updatedAt,
        outcome:
          j.step === 'filed' && d?.clientName
            ? { kind: 'filed' as const, clientName: d.clientName }
            : j.step === 'review'
              ? { kind: 'review' as const, reason: d?.reviewReason ?? null }
              : null,
      };
    });
  };

  router.get('/batches/:id', async (req, res) => {
    const batchId = String(req.params.id);
    if (!(await partnersOnly(req, res, 'view_batch', { batchId }))) return;
    const batch = await getBatch(db, batchId);
    if (!batch) return error(res, 404, 'No such batch');
    const jobs = (await listJobs(db, { batchId, limit: 100 })).reverse();
    return res.json({ ...batch, items: await jobView(jobs) });
  });

  router.get('/jobs', async (req, res) => {
    if (!(await partnersOnly(req, res, 'view_jobs', {}))) return;
    const status = req.query.status === 'dead' ? 'dead' : undefined;
    return res.json({ items: await jobView(await listJobs(db, { status, limit: 50 })) });
  });

  router.post('/jobs/:id/retry', async (req, res) => {
    const jobId = Number(req.params.id);
    if (!(await partnersOnly(req, res, 'retry_job', { jobId }))) return;
    const job = Number.isInteger(jobId) ? await getJob(db, jobId) : null;
    if (!job || job.status !== 'dead') return error(res, 404, 'No dead job with that id');
    // Only while the document is still waiting in the inbox: if someone filed it by hand meanwhile, leave it.
    if (!(await setProcessing(db, job.documentId, true))) {
      return error(res, 409, 'The document has been handled since; nothing to retry');
    }
    await retryDead(db, job.id);
    await audit(req.staff!, 'dashboard:retry_job', { jobId }, 'ok', job.documentId);
    return res.json({ ok: true });
  });

  router.get('/documents/:id/file', async (req, res) => {
    const actor = req.staff!;
    const doc = await getDocument(db, String(req.params.id));
    if (!doc) return error(res, 404, 'Not found');
    const access = await canSeeDocument({ db, actor }, doc, await ensureMatch(db, services, doc));
    if (!access.allowed) {
      await audit(actor, 'dashboard:view_document', { documentId: doc.id }, 'denied', access.detail);
      return error(res, 403, access.reason);
    }
    await audit(actor, 'dashboard:view_document', { documentId: doc.id }, 'ok');
    return sendDocumentFile(res, services, doc);
  });

  // `report`: the latest model run (Claude or Groq), published. `baseline`: the offline rules run CI makes on every
  // push. Without a model run, `report` falls back to the baseline.
  router.get('/accuracy', async (req, res) => {
    const files = req.query.run === 'baseline' ? ['baseline'] : ['report', 'baseline'];
    for (const file of files) {
      try {
        const report = await readFile(join(deps.projectRoot, 'eval', `${file}.json`), 'utf8');
        return res.type('application/json').send(report);
      } catch {
        // Try the next one.
      }
    }
    return error(res, 404, 'No accuracy report yet');
  });

  router.use((_req: Request, res: Response) => error(res, 404, 'Not found'));
  return router;
}
