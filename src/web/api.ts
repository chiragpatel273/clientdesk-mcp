import { inferTaxYear } from '../ai/extraction.js';
import { errorCategory, usageScope } from '../ai/usage.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import type { Config } from '../config.js';
import { firmOf, type Db } from '../db/index.js';
import { accessibleClientIds, canAccessClient, noteCrossFirm, partitionByAccess } from '../domain/access.js';
import { recordAudit } from '../domain/audit.js';
import { countOpenItems, listAudit, staffNames, toolCallsToday } from '../domain/dashboard.js';
import {
  documentCounts,
  BatchFullError,
  documentSummaries,
  getDocument,
  ingestDocument,
  isUniqueViolation,
  listDocumentsByStatus,
  markFiled,
  refreshPassages,
  titleForFiling,
  MAX_UPLOAD_BYTES,
  SUPPORTED_TYPES,
  type DocumentRecord,
} from '../domain/documents.js';
import { usageSummary } from '../domain/usage.js';
import { findActorByEmail, findActorById } from '../domain/staff.js';
import type { Actor } from '../domain/types.js';
import { ensureMatch, isJudged } from '../domain/intake.js';
import { canSeeDocument } from '../mcp/document-access.js';
import { createBatch, findJobByKey, getBatch, getJob, listJobs, retryDead } from '../jobs/queue.js';
import type { AppServices } from '../services.js';
import { rateLimit } from './rate-limit.js';
import { readSession } from './session.js';

const DEV_USER_HEADER = 'x-clientdesk-user';
export const CSRF_HEADER = 'x-clientdesk-csrf';

type Deps = { db: Db; config: Config; services: AppServices; projectRoot: string; onJobQueued?: () => void };

declare module 'express-serve-static-core' {
  interface Request {
    staff?: Actor;
    /** The database scoped to the signed-in staff member's firm (domain filter + row-level security). */
    db?: Db;
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

/** A whole number from a query string, within bounds; anything else becomes the default. */
function wholeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) && n !== 0 ? Math.min(Math.max(n, min), max) : fallback;
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
  const { db: rootDb, config, services } = deps;
  const router = Router();
  // The demo is public: its visitors can look around, but not flood the database with audit rows.
  const demoReads = rateLimit([
    { max: 150, windowMs: 60_000 },
    { max: 2000, windowMs: 3_600_000 },
  ]);
  const demoWrites = rateLimit([
    { max: 20, windowMs: 60_000 },
    { max: 100, windowMs: 3_600_000 },
  ]);

  // Who is calling: a session cookie (dashboard sign-in or "Try the demo") in either auth mode, else, in dev mode
  // only, the dev header.
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = await resolveDashboardActor(req, rootDb, config);
      if (!actor) return error(res, 401, 'Not signed in');
      req.staff = actor;
      req.db = rootDb.forFirm(actor.firmId);
      // Read-only (demo) sessions: every write is refused and audited here, before anything else is looked at (the CSRF
      // header, the body), so routes added later inherit the rule.
      const reading = req.method === 'GET' || req.method === 'HEAD';
      if (actor.readOnly) {
        let within = false;
        (reading ? demoReads : demoWrites)(req, res, () => (within = true));
        if (!within) return;
      }
      if (actor.readOnly && !reading) {
        await recordAudit(req.db, {
          staffId: actor.staffId,
          tool: `dashboard:${writeActionName(req.path)}`,
          input: { method: req.method, path: req.path.slice(0, 200) },
          outcome: 'denied',
          detail: 'read-only session',
          durationMs: 0,
        });
        return error(res, 403, 'This is a read-only demo session, so nothing can be changed.');
      }
      // State-changing requests must carry a custom header: a cross-site form or image can't add one.
      if (req.method !== 'GET' && req.header(CSRF_HEADER) !== '1') return error(res, 403, 'Missing CSRF header');
      return next();
    } catch (err) {
      return next(err);
    }
  });

  // Model calls a dashboard request makes (embedding an upload, extracting to decide who may view a file) are
  // recorded as this staff member's.
  const scoped = <T>(req: Request, fn: () => Promise<T>, documentId?: string) =>
    usageScope({ db: req.db!, staffId: req.staff!.staffId, source: 'dashboard', documentId }, fn);

  /** A lookup by id found nothing: logged the same whether the id is another firm's or made up (see notFoundAudit). */
  const auditUnknownId = async (
    req: Request,
    action: string,
    kind: 'client' | 'document' | 'job' | 'batch',
    id: string,
  ): Promise<void> => {
    await noteCrossFirm(req.db!, req.staff!, `dashboard:${action}`, kind, id);
    await audit(req, `dashboard:${action}`, { [`${kind}Id`]: id.slice(0, 100) }, 'denied', 'unknown id');
  };

  // Our ids are short and plain; anything else (a NUL byte, say) is simply not found.
  router.param('id', (_req, res, next, id: string) =>
    /^[\w-]{1,100}$/.test(id) ? next() : void error(res, 404, 'Not found'),
  );

  const audit = (req: Request, tool: string, input: unknown, outcome: 'ok' | 'denied' | 'error', detail?: string) =>
    recordAudit(req.db!, { staffId: req.staff!.staffId, tool, input, outcome, detail, durationMs: 0 });

  router.get('/me', async (req, res) => {
    const db = req.db!;
    const a = req.staff!;
    const [firm] = await db.query<{ id: string; name: string }>('select id, name from firms where id = $1', [
      firmOf(db),
    ]);
    res.json({
      staffId: a.staffId,
      name: a.name,
      email: a.email,
      role: a.role,
      readOnly: a.readOnly,
      firm: firm ?? { id: a.firmId, name: a.firmId },
      authMode: config.authMode,
    });
  });

  router.get('/staff', async (_req, res) => {
    if (config.authMode !== 'dev') return error(res, 404, 'Not available');
    // Dev mode only: everyone in every firm, so a developer can switch firms too. The demo visitor isn't a person
    // to switch to; it is reached through "Try the demo".
    const staff = await rootDb.query<{ email: string; name: string; role: string; firm: string }>(
      `select s.email, s.name, s.role, f.name as firm from staff s join firms f on f.id = s.firm_id
       where not s.read_only order by s.firm_id = 'firm_northbridge' desc, f.name, s.role desc, s.name`,
    );
    return res.json({ staff });
  });

  router.get('/stats', async (req, res) => {
    const db = req.db!;
    const actor = req.staff!;
    res.json({
      documents: await documentCounts(db),
      toolCallsToday: await toolCallsToday(db, actor),
      openItems: await countOpenItems(db, await accessibleClientIds(db, actor)),
    });
  });

  router.get('/audit', async (req, res) => {
    const db = req.db!;
    const limit = wholeNumber(req.query.limit, 50, 1, 200);
    const before = req.query.before ? wholeNumber(req.query.before, 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
    const outcome = ['ok', 'denied', 'error'].includes(String(req.query.outcome))
      ? String(req.query.outcome)
      : undefined;
    const tool = typeof req.query.tool === 'string' && req.query.tool ? req.query.tool.slice(0, 100) : undefined;
    res.json(await listAudit(db, req.staff!, { limit, before: before || undefined, outcome, tool }));
  });

  router.get('/inbox', async (req, res) => {
    const db = req.db!;
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
    const db = req.db!;
    const actor = req.staff!;
    const names = await staffNames(db);
    const rows = await db.query<{ id: string; sent_to_review_by: string | null }>(
      `select id, sent_to_review_by from documents where status = 'review' and firm_id = $1
       order by sent_to_review_at desc nulls last`,
      [firmOf(db)],
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
    const db = req.db!;
    const actor = req.staff!;
    const input = { documentId: req.params.id, clientId: req.body?.clientId, taxYear: req.body?.taxYear };
    if (actor.role !== 'partner') {
      await audit(req, 'dashboard:resolve_review', input, 'denied', 'partners only');
      return error(res, 403, 'Only partners can resolve reviews');
    }
    if (typeof input.clientId !== 'string' || !(await canAccessClient(db, actor, input.clientId))) {
      if (typeof input.clientId === 'string') await auditUnknownId(req, 'resolve_review', 'client', input.clientId);
      return error(res, 400, 'Choose a client');
    }
    const [client] = await db.query<{ name: string }>('select name from clients where id = $1 and firm_id = $2', [
      input.clientId,
      firmOf(db),
    ]);
    if (!client) return error(res, 400, 'Unknown client');
    const doc = await getDocument(db, String(req.params.id));
    if (!doc || doc.status !== 'review') {
      if (!doc) await auditUnknownId(req, 'resolve_review', 'document', String(req.params.id));
      return error(res, 404, 'Not in the review queue');
    }
    const taxYear =
      Number.isInteger(input.taxYear) && input.taxYear >= 2000 && input.taxYear <= 2100
        ? (input.taxYear as number)
        : doc.extraction
          ? inferTaxYear(doc.extraction)
          : null;
    const docType = doc.extraction?.docType ?? null;
    // Filing, its CRM note and its audit row are one statement; search passages follow (and are repaired if that fails).
    const filed = await markFiled(db, {
      id: doc.id,
      clientId: input.clientId,
      taxYear,
      docType,
      staffId: actor.staffId,
      title: titleForFiling(doc, doc.extraction),
      note: `Filed "${doc.title}" from the review queue (reason: ${doc.reviewReason ?? 'n/a'}).`,
      audit: { tool: 'dashboard:resolve_review', input, detail: `filed to ${input.clientId}` },
    });
    if (!filed) {
      await audit(req, 'dashboard:resolve_review', input, 'error', 'the document changed');
      return error(res, 409, 'The document changed; reload the queue');
    }
    await scoped(req, () => refreshPassages(db, services.embedder, doc.id), doc.id);
    return res.json({ ok: true });
  });

  router.post(
    '/documents',
    express.raw({ type: Object.keys(SUPPORTED_TYPES), limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      const db = req.db!;
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
        const result = await scoped(req, () =>
          ingestDocument(db, services, {
            bytes: new Uint8Array(req.body),
            mimeType,
            filename: filename || null,
            uploadedBy: actor.staffId,
          }),
        );
        const doc = await getDocument(db, result.id);
        await audit(req, 'dashboard:upload', { filename, bytes: req.body.length }, 'ok', result.id);
        // A duplicate may be another team's document: its title is shown only to someone who may see it.
        const showTitle = doc && (!result.duplicate || (await canSeeDocument({ db, actor }, doc, doc.match)).allowed);
        return res.json({
          id: result.id,
          title: showTitle ? doc.title : filename || 'Document',
          duplicate: result.duplicate,
        });
      } catch (err) {
        await audit(req, 'dashboard:upload', { filename }, 'error', errorCategory(err));
        return error(res, 400, 'Could not read that file');
      }
    },
  );

  // ---------- batch intake (partners only) ----------

  const partnersOnly = async (
    req: Request,
    res: Response,
    action: string,
    input: unknown,
    message = 'Only partners can use batch intake',
  ): Promise<boolean> => {
    const actor = req.staff!;
    if (actor.role === 'partner') return true;
    await audit(req, `dashboard:${action}`, input, 'denied', 'partners only');
    error(res, 403, message);
    return false;
  };

  router.post('/batches', express.json({ limit: '1kb' }), async (req, res) => {
    const db = req.db!;
    const total = Number(req.body?.total);
    if (!(await partnersOnly(req, res, 'create_batch', { total }))) return;
    if (!Number.isInteger(total) || total < 1 || total > 25) return error(res, 400, 'A batch holds 1 to 25 files');
    const id = await createBatch(db, req.staff!.staffId, total);
    await audit(req, 'dashboard:create_batch', { total }, 'ok', id);
    return res.json({ id });
  });

  router.post(
    '/batches/:id/files',
    // Before the body is read: up to 15 MB is only buffered for someone who may upload it.
    async (req, res, next) => {
      const batchId = String(req.params.id);
      if (!(await partnersOnly(req, res, 'batch_upload', { batchId }))) return;
      const batch = await getBatch(req.db!, batchId);
      if (batch && batch.createdBy === req.staff!.staffId) return next();
      await auditUnknownId(req, 'batch_upload', 'batch', batchId);
      error(res, 404, 'No such batch');
    },
    express.raw({ type: Object.keys(SUPPORTED_TYPES), limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      const db = req.db!;
      const actor = req.staff!;
      const batchId = String(req.params.id);
      const filename = String(req.header('x-filename') ?? '')
        .replace(/[^\w.\- ]+/g, '_')
        .slice(0, 120);
      const input = { batchId, filename };
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
      try {
        const existing = key ? await findJobByKey(db, key) : null;
        if (existing) return res.json({ documentId: existing.documentId, jobId: existing.id, duplicate: false });
        const result = await ingestDocument(db, services, {
          bytes: new Uint8Array(req.body),
          mimeType,
          filename: filename || null,
          uploadedBy: actor.staffId,
          intakeJob: {
            createdBy: actor.staffId,
            batchId,
            idempotencyKey: key,
            maxAttempts: config.jobs.maxAttempts,
          },
        });
        if (result.duplicate) {
          // Two copies of the same retried request can race: the loser gets the winner's job, not "duplicate".
          const raced = key ? await findJobByKey(db, key) : null;
          if (raced) return res.json({ documentId: raced.documentId, jobId: raced.id, duplicate: false });
          await audit(req, 'dashboard:batch_upload', input, 'ok', `duplicate of ${result.id}`);
          return res.json({ documentId: result.id, jobId: null, duplicate: true });
        }
        deps.onJobQueued?.();
        await audit(req, 'dashboard:batch_upload', input, 'ok', `${result.id} job ${result.jobId}`);
        return res.json({ documentId: result.id, jobId: result.jobId, duplicate: false });
      } catch (err) {
        // The same key at the same moment: the first request won, and may have taken the batch's last place.
        const full = err instanceof BatchFullError;
        const raced = key && (full || isUniqueViolation(err)) ? await findJobByKey(db, key) : null;
        if (raced) return res.json({ documentId: raced.documentId, jobId: raced.id, duplicate: false });
        if (full) {
          await audit(req, 'dashboard:batch_upload', input, 'error', 'batch full');
          return error(res, 409, 'This batch already has all its files');
        }
        await audit(req, 'dashboard:batch_upload', input, 'error', errorCategory(err));
        return error(res, 400, 'Could not store that file');
      }
    },
  );

  const jobView = async (db: Db, jobs: Awaited<ReturnType<typeof listJobs>>) => {
    const docs = await documentSummaries(
      db,
      jobs.map((j) => j.documentId),
    );
    return jobs.map((j) => {
      const d = docs.get(j.documentId);
      return {
        jobId: j.id,
        documentId: j.documentId,
        title: d?.title ?? j.documentId,
        filename: d?.filename ?? null,
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
    const db = req.db!;
    const batchId = String(req.params.id);
    if (!(await partnersOnly(req, res, 'view_batch', { batchId }))) return;
    const batch = await getBatch(db, batchId);
    if (!batch) {
      await auditUnknownId(req, 'view_batch', 'batch', batchId);
      return error(res, 404, 'No such batch');
    }
    const jobs = (await listJobs(db, { batchId, limit: 100 })).reverse();
    // Someone is waiting for this batch: if it has work left (queued by another server, say), don't sleep through it.
    if (jobs.some((j) => j.status === 'queued' || j.status === 'running')) deps.onJobQueued?.();
    return res.json({ ...batch, items: await jobView(db, jobs) });
  });

  router.get('/jobs', async (req, res) => {
    const db = req.db!;
    if (!(await partnersOnly(req, res, 'view_jobs', {}))) return;
    const status = req.query.status === 'dead' ? 'dead' : undefined;
    return res.json({ items: await jobView(db, await listJobs(db, { status, limit: 50 })) });
  });

  router.post('/jobs/:id/retry', async (req, res) => {
    const db = req.db!;
    const jobId = Number(req.params.id);
    if (!(await partnersOnly(req, res, 'retry_job', { jobId }))) return;
    const job = Number.isSafeInteger(jobId) ? await getJob(db, jobId) : null;
    if (!job || job.status !== 'dead') {
      if (!job && Number.isSafeInteger(jobId)) await auditUnknownId(req, 'retry_job', 'job', String(jobId));
      return error(res, 404, 'No dead job with that id');
    }
    // Only while the document is still waiting in the inbox: if someone filed it by hand meanwhile, leave it.
    if (!(await retryDead(db, job.id))) {
      return error(res, 409, 'The document has been handled since; nothing to retry');
    }
    deps.onJobQueued?.();
    await audit(req, 'dashboard:retry_job', { jobId }, 'ok', job.documentId);
    return res.json({ ok: true });
  });

  router.get('/documents/:id/file', async (req, res) => {
    const db = req.db!;
    const actor = req.staff!;
    const doc = await getDocument(db, String(req.params.id));
    if (!doc) {
      await auditUnknownId(req, 'view_document', 'document', String(req.params.id));
      return error(res, 404, 'Not found');
    }
    const judged = await scoped(req, () => ensureMatch(db, services, doc, actor), doc.id).catch((err: unknown) => err);
    if (!isJudged(judged)) {
      // Storage or the model is failing, so nobody can tell whose document this is: not shown, and said so.
      await audit(req, 'dashboard:view_document', { documentId: doc.id }, 'error', errorCategory(judged));
      return error(res, 503, 'This document can’t be checked right now. Try again in a few minutes.');
    }
    const access = await canSeeDocument({ db, actor }, judged.doc, judged.match);
    if (!access.allowed) {
      await audit(req, 'dashboard:view_document', { documentId: doc.id }, 'denied', access.detail);
      return error(res, judged.doc.status === 'processing' ? 409 : 403, access.reason);
    }
    await audit(req, 'dashboard:view_document', { documentId: doc.id }, 'ok');
    return sendDocumentFile(res, services, doc);
  });

  // LLM usage and estimated cost (partners). Eval runs are separate processes with their own database, so their
  // usage travels in the accuracy reports and is shown next to it.
  router.get('/usage', async (req, res) => {
    const db = req.db!;
    const days = wholeNumber(req.query.days, 14, 1, 90);
    if (!(await partnersOnly(req, res, 'view_usage', { days }, 'Only partners can see usage and cost'))) return;
    const evalRuns = [];
    for (const file of ['report', 'baseline']) {
      try {
        const report = JSON.parse(await readFile(join(deps.projectRoot, 'eval', `${file}.json`), 'utf8')) as {
          generatedAt?: string;
          extractor?: string;
          usage?: unknown;
        };
        evalRuns.push({
          run: file,
          generatedAt: report.generatedAt,
          extractor: report.extractor,
          usage: report.usage ?? null,
        });
      } catch {
        // No report of that kind yet.
      }
    }
    return res.json({ ...(await usageSummary(db, days)), evalRuns });
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
