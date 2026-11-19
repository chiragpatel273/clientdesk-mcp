import { inferTaxYear } from '../ai/extraction.js';
import type { Db } from '../db/index.js';
import { canAccessClient } from '../domain/access.js';
import { recordAudit } from '../domain/audit.js';
import {
  getDocument,
  markFiled,
  markForReview,
  readStoredText,
  reindexDocument,
  retitleAndReindex,
} from '../domain/documents.js';
import { computeMatch, ensureExtraction } from '../domain/intake.js';
import { addNote } from '../domain/open-items.js';
import { findActorById } from '../domain/staff.js';
import type { Actor } from '../domain/types.js';
import type { AppServices } from '../services.js';
import type { Job, Step } from './queue.js';

/** A failure that retrying can't fix (the uploader lost access, the document was removed): dead-letter at once. */
export class PermanentJobError extends Error {
  override name = 'PermanentJobError';
  /** An access check failed (audited as `denied`), rather than the document's state. */
  readonly denied: boolean;

  constructor(message: string, options: { denied?: boolean } = {}) {
    super(message);
    this.denied = options.denied ?? false;
  }
}

export interface StepResult {
  step: Step;
  done: boolean;
  /** For the audit log (partners only): what the step found. */
  detail?: string;
}

/**
 * Batch intake runs as the partner who uploaded the batch, and each step checks again that they still may: a
 * staff member removed or demoted mid-batch stops the pipeline. Partners see every client; the filing step still
 * calls canAccessClient for the chosen client, so the rule holds if batch intake is ever opened to assistants.
 */
async function uploader(db: Db, job: Job): Promise<Actor> {
  const actor = await findActorById(db, job.createdBy);
  if (!actor || actor.role !== 'partner' || actor.readOnly) {
    throw new PermanentJobError('The uploader is no longer a partner, so the batch stopped.', { denied: true });
  }
  return actor;
}

/** Runs the step after `job.step`. Each step is safe to run twice (a worker can die after the work, before the record). */
export async function runIntakeStep(db: Db, services: AppServices, job: Job): Promise<StepResult> {
  const actor = await uploader(db, job);
  const doc = await getDocument(db, job.documentId);
  if (!doc) throw new PermanentJobError('The document no longer exists.');
  if (doc.status !== 'processing')
    throw new PermanentJobError(`The document is no longer being processed (${doc.status}).`);

  switch (job.step) {
    case 'stored': {
      const { pages } = await readStoredText(db, services.files, doc.id);
      return { step: 'text_extracted', done: false, detail: `${pages} pages` };
    }
    case 'text_extracted': {
      await reindexDocument(db, services.embedder, doc.id);
      return { step: 'embedded', done: false, detail: services.embedder.model };
    }
    case 'embedded': {
      const extraction = await ensureExtraction(db, services, doc);
      return { step: 'fields_extracted', done: false, detail: `${extraction.docType} by ${extraction.model}` };
    }
    case 'fields_extracted': {
      const extraction = await ensureExtraction(db, services, doc);
      const match = await computeMatch(db, services, doc, extraction);
      const best = match.candidates[0];
      return {
        step: 'matched',
        done: false,
        detail: `${match.decision}${best ? `: ${best.clientId} at ${best.confidence}` : ''}`,
      };
    }
    case 'matched': {
      const extraction = await ensureExtraction(db, services, doc);
      // The filing rule is exactly the one file_document uses: matchClients decided `file` only for a clear match
      // above the threshold, with look-alikes needing a second identifier.
      const match = doc.match ?? (await computeMatch(db, services, doc, extraction));
      const best = match.candidates[0];
      if (match.decision === 'file' && best && (await canAccessClient(db, actor, best.clientId))) {
        const taxYear = inferTaxYear(extraction);
        const filed = await markFiled(
          db,
          { id: doc.id, clientId: best.clientId, taxYear, docType: extraction.docType, staffId: actor.staffId },
          ['processing'],
        );
        if (!filed) throw new PermanentJobError('The document changed while filing.');
        await retitleAndReindex(db, services.embedder, doc.id, extraction);
        const title = (await getDocument(db, doc.id))?.title ?? doc.title;
        await addNote(db, {
          clientId: best.clientId,
          authorId: actor.staffId,
          body: `Filed "${title}" automatically from batch intake (${Math.round(best.confidence * 100)}% match).`,
          kind: 'filing',
        });
        return { step: 'filed', done: true, detail: `filed to ${best.clientId} at ${best.confidence}` };
      }
      const reason = match.decision === 'file' ? 'The uploader is not assigned to the matched client.' : match.reason;
      if (!(await markForReview(db, { id: doc.id, reason, staffId: actor.staffId }, ['processing']))) {
        throw new PermanentJobError('The document changed while sending it to review.');
      }
      return { step: 'review', done: true, detail: reason };
    }
    default:
      throw new PermanentJobError(`Nothing to do after step ${job.step}.`);
  }
}

/** One audit row per step, as the uploader, so the audit log shows the whole pipeline. */
export async function auditStep(
  db: Db,
  job: Job,
  step: string,
  outcome: 'ok' | 'denied' | 'error',
  detail?: string,
): Promise<void> {
  await recordAudit(db, {
    staffId: job.createdBy,
    tool: `job:${step}`,
    input: { jobId: job.id, documentId: job.documentId, batchId: job.batchId, attempt: job.attempts },
    outcome,
    detail,
    durationMs: 0,
  });
}
