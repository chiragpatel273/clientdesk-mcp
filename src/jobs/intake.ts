import { inferTaxYear } from '../ai/extraction.js';
import { firmOf, type Db } from '../db/index.js';
import { canAccessClient } from '../domain/access.js';
import { getDocument, readStoredText, reindexDocument, titleForFiling } from '../domain/documents.js';
import { DocumentTooLargeError } from '../documents/text.js';
import { computeMatch, ensureExtraction } from '../domain/intake.js';
import { findActorById } from '../domain/staff.js';
import type { Actor } from '../domain/types.js';
import type { AppServices } from '../services.js';
import { completeFiling, completeReview, type Job, type Step } from './queue.js';

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
  /** The audit row's name when it isn't the step's. */
  auditAs?: string;
  /** The step already recorded itself (filing and review are atomic with the job's own state). */
  recorded?: boolean;
}

/**
 * Batch intake runs as the partner who uploaded the batch, and each step checks again that they still may: a
 * staff member removed or demoted mid-batch stops the pipeline. Partners see every client; the filing step still
 * calls canAccessClient for the chosen client, so the rule holds if batch intake is ever opened to assistants.
 */
async function uploader(db: Db, job: Job): Promise<Actor> {
  const actor = await findActorById(db, job.createdBy);
  if (!actor || actor.firmId !== firmOf(db) || actor.role !== 'partner' || actor.readOnly) {
    throw new PermanentJobError('The uploader is no longer a partner, so the batch stopped.', { denied: true });
  }
  return actor;
}

/**
 * Runs the step after `job.step`. A worker can die after the work but before recording it, so steps before the decision
 * only rebuild the same thing (text, passages, cached extraction, match), and the decision itself (file or review) is
 * one statement with the job's state: it happens once or not at all.
 */
export async function runIntakeStep(db: Db, services: AppServices, job: Job): Promise<StepResult> {
  const doc = await getDocument(db, job.documentId);
  if (!doc) throw new PermanentJobError('The document no longer exists.');
  if (job.step === 'filed') {
    // Already filed, by a partner who was allowed to: only its search passages are rebuilt, with the client and title it has
    // now. That is housekeeping, whoever the uploader is by now.
    await reindexDocument(db, services.embedder, doc.id);
    return { step: 'filed', done: true, detail: services.embedder.model, auditAs: 'reindexed' };
  }
  const actor = await uploader(db, job);
  if (doc.status !== 'processing')
    throw new PermanentJobError(`The document is no longer being processed (${doc.status}).`);

  switch (job.step) {
    case 'stored': {
      const { pages } = await readStoredText(db, services.files, doc.id).catch((error: unknown) => {
        // Trying again won't make it smaller.
        throw error instanceof DocumentTooLargeError ? new PermanentJobError(error.message) : error;
      });
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
      // The filing rule is exactly the one file_document uses, recomputed now as it does: matchClients decides `file`
      // only for a clear match above the threshold, with look-alikes needing a second identifier.
      const match = await computeMatch(db, services, doc, extraction);
      const best = match.candidates[0];
      if (match.decision === 'file' && best && (await canAccessClient(db, actor, best.clientId))) {
        const title = titleForFiling(doc, extraction);
        const detail = `filed to ${best.clientId} at ${best.confidence}`;
        const filed = await completeFiling(db, job, {
          clientId: best.clientId,
          taxYear: inferTaxYear(extraction),
          docType: extraction.docType,
          title,
          note: `Filed "${title}" automatically from batch intake (${Math.round(best.confidence * 100)}% match).`,
          detail,
        });
        if (!filed) throw new PermanentJobError('The document changed while filing.');
        return { step: 'filed', done: false, recorded: true, detail };
      }
      const reason = match.decision === 'file' ? 'The uploader is not assigned to the matched client.' : match.reason;
      if (!(await completeReview(db, job, reason))) {
        throw new PermanentJobError('The document changed while sending it to review.');
      }
      return { step: 'review', done: true, recorded: true, detail: reason };
    }
    default:
      throw new PermanentJobError(`Nothing to do after step ${job.step}.`);
  }
}
