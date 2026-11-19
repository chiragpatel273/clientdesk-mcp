import { usageScope } from '../ai/usage.js';
import type { JobsConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { setProcessing } from '../domain/documents.js';
import type { AppServices } from '../services.js';
import { auditStep, PermanentJobError, runIntakeStep } from './intake.js';
import { advance, claimNext, fail, workerId, type Job } from './queue.js';

export interface Worker {
  readonly id: string;
  /** Claims and runs one step. False when nothing was due. */
  tick(): Promise<boolean>;
  /** Runs steps until no job is due (tests, scripts). Returns how many steps ran. */
  runUntilIdle(maxSteps?: number): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export interface WorkerDeps {
  db: Db;
  services: AppServices;
  config: JobsConfig;
  log?: (msg: string) => void;
  /** How long an idle loop waits before looking again. */
  pollMs?: number;
}

/**
 * Runs intake jobs: claim (SKIP LOCKED) → run one step → advance, retry with backoff, or dead-letter. `concurrency`
 * loops share one process; several processes (or instances) can run side by side on the same database.
 */
export function createWorker(deps: WorkerDeps): Worker {
  const { db, services, config } = deps;
  const log = deps.log ?? (() => {});
  const pollMs = deps.pollMs ?? 1000;
  const id = workerId();
  let running = false;
  let loops: Promise<void>[] = [];
  const sleepers = new Set<() => void>();

  async function handleFailure(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const permanent = error instanceof PermanentJobError;
    // A permanent failure uses up the remaining attempts, so it is dead-lettered now instead of retried.
    const result = await fail(db, permanent ? { ...job, attempts: job.maxAttempts } : job, id, message, config);
    const denied = error instanceof PermanentJobError && error.denied;
    await auditStep(db, job, result === 'dead' ? 'dead_letter' : 'retry', denied ? 'denied' : 'error', message);
    if (result === 'dead') {
      // People take over: the document goes back to the inbox, where Claude or a partner can process it by hand.
      await setProcessing(db, job.documentId, false);
      log(`Job ${job.id} dead-lettered after ${job.attempts} attempts: ${message}`);
    }
  }

  async function tick(): Promise<boolean> {
    const job = await claimNext(db, id, config);
    if (!job) return false;
    if (job.attempts > job.maxAttempts) {
      // Reclaimed after its worker stopped answering, too many times.
      await handleFailure(job, new Error('The worker running this job stopped responding too many times.'));
      return true;
    }
    try {
      const result = await usageScope(
        { db, staffId: job.createdBy, source: 'job', documentId: job.documentId, jobId: job.id },
        () => runIntakeStep(db, services, job),
      );
      if (await advance(db, job, id, result.step, result.done))
        await auditStep(db, job, result.step, 'ok', result.detail);
    } catch (error) {
      await handleFailure(job, error);
    }
    return true;
  }

  async function loop(): Promise<void> {
    while (running) {
      let worked = false;
      try {
        worked = await tick();
      } catch (error) {
        // The database itself failed (connection lost): wait and try again rather than crash the server.
        log(`Worker ${id} could not reach the job queue: ${error instanceof Error ? error.message : error}`);
      }
      if (!worked && running) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            sleepers.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, pollMs);
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
    async stop() {
      running = false;
      for (const wake of [...sleepers]) wake();
      await Promise.all(loops);
      loops = [];
    },
  };
}
