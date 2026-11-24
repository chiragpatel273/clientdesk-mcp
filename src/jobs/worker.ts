import { errorCategory, usageScope } from '../ai/usage.js';
import type { JobsConfig } from '../config.js';
import type { Db } from '../db/index.js';
import type { AppServices } from '../services.js';
import { PermanentJobError, runIntakeStep } from './intake.js';
import { advance, claimNext, fail, heartbeat, nextDueMs, workerId, type Job } from './queue.js';

/** How long a running step is kept from counting as stuck. */
const MAX_STEP_MS = 30 * 60_000;

export interface Worker {
  readonly id: string;
  /** Claims and runs one step. False when nothing was due. */
  tick(): Promise<boolean>;
  /** Runs steps until no job is due (tests, scripts). Returns how many steps ran. */
  runUntilIdle(maxSteps?: number): Promise<number>;
  start(): void;
  /** Something was queued: look now instead of waiting out the idle pause. */
  wake(): void;
  stop(): Promise<void>;
}

export interface WorkerDeps {
  db: Db;
  services: AppServices;
  config: JobsConfig;
  log?: (msg: string) => void;
  /**
   * The longest an idle loop waits before looking again. With nothing due it waits this long (or until `wake()`, a retry
   * or a stuck job is due), instead of asking the database every second and keeping a serverless one (Neon) awake.
   * A worker in its own process can't be woken by uploads, so it uses a short pause.
   */
  idleMs?: number;
}

/**
 * Runs intake jobs: claim (SKIP LOCKED) → run one step → advance, retry with backoff, or dead-letter. `concurrency`
 * loops share one process; several processes (or instances) can run side by side on the same database.
 */
export function createWorker(deps: WorkerDeps): Worker {
  const { db, services, config } = deps;
  const log = deps.log ?? (() => {});
  const idleMs = deps.idleMs ?? 10 * 60_000;
  const id = workerId();
  let running = false;
  let loops: Promise<void>[] = [];
  const sleepers = new Set<() => void>();

  async function handleFailure(job: Job, error: unknown): Promise<void> {
    // Only the kind of error is kept: provider and storage messages can hold host names or the model's partial answer.
    const message = error instanceof PermanentJobError ? error.message : errorCategory(error);
    const permanent = error instanceof PermanentJobError;
    // A permanent failure uses up the remaining attempts, so it is dead-lettered now instead of retried. Dead-lettering
    // also hands the document back to the inbox, where Claude or a partner can process it by hand.
    const result = await fail(db, permanent ? { ...job, attempts: job.maxAttempts } : job, message, config, {
      denied: permanent && error.denied,
    });
    if (result === 'dead') log(`Job ${job.id} dead-lettered after ${job.attempts} attempts.`);
  }

  async function tick(): Promise<boolean> {
    const job = await claimNext(db, id, config);
    if (!job) return false;
    if (job.attempts > job.maxAttempts) {
      // Reclaimed after its worker stopped answering, too many times.
      await handleFailure(job, new Error('The worker running this job stopped responding too many times.'));
      return true;
    }
    // The step touches only the job's firm: scoped handle (domain filter + row-level security).
    const firmDb = db.forFirm(job.firmId);
    // A slow step (a rate-limited model) is not a stuck one, up to a point: a step that hangs is given up for lost.
    const startedAt = Date.now();
    const beat = setInterval(
      () => {
        if (Date.now() - startedAt > MAX_STEP_MS) clearInterval(beat);
        else void heartbeat(db, job).catch(() => undefined);
      },
      (config.stuckSeconds * 1000) / 3,
    );
    beat.unref();
    try {
      const result = await usageScope(
        { db: firmDb, staffId: job.createdBy, source: 'job', documentId: job.documentId, jobId: job.id },
        () => runIntakeStep(firmDb, services, job),
      );
      if (!result.recorded) {
        await advance(db, job, result.step, result.done, { detail: result.detail, auditAs: result.auditAs });
      }
    } catch (error) {
      await handleFailure(job, error);
    } finally {
      clearInterval(beat);
    }
    return true;
  }

  async function loop(): Promise<void> {
    while (running) {
      let worked = false;
      let pause = idleMs;
      try {
        worked = await tick();
        if (!worked) pause = Math.min(idleMs, (await nextDueMs(db, config)) ?? idleMs);
      } catch (error) {
        pause = Math.min(idleMs, 5000);
        // The database itself failed (connection lost): wait and try again rather than crash the server.
        log(`Worker ${id} could not reach the job queue: ${errorCategory(error)}`);
      }
      if (!worked && running) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            sleepers.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, Math.max(pause, 100));
          sleepers.add(wake);
        });
      }
    }
  }

  return {
    id,
    tick,
    async runUntilIdle(maxSteps = 1000) {
      let steps = 0;
      while (steps < maxSteps && (await tick())) steps++;
      return steps;
    },
    start() {
      if (running) return;
      running = true;
      loops = Array.from({ length: config.concurrency }, () => loop());
      log(`Job worker ${id} started (${config.concurrency} at a time).`);
    },
    wake() {
      for (const wake of [...sleepers]) wake();
    },
    async stop() {
      running = false;
      for (const wake of [...sleepers]) wake();
      await Promise.all(loops);
      loops = [];
    },
  };
}
