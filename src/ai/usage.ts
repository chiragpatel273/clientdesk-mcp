import { AsyncLocalStorage } from 'node:async_hooks';
import { firmOf, type Db } from '../db/index.js';
import { estimateCost } from './prices.js';

/**
 * LLM usage recording. Model call sites (extractors, embedders) report each call with `reportCall`; who and what it
 * was for comes from the surrounding `usageScope` (an AsyncLocalStorage context set by runTool, the dashboard API,
 * the job worker and start-up), so call sites don't need the database or the actor passed down.
 * Only counts and timings are stored: never prompts, document text or answers.
 */

export type UsageSource = 'mcp' | 'dashboard' | 'job' | 'startup' | 'script';

export interface LlmCall {
  operation: 'extract' | 'embed' | 'rerank';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Offline models report no tokens: counted as characters / 4. */
  tokensEstimated?: boolean;
  latencyMs: number;
  /** The larger model's second look at a document the small one was unsure about. */
  escalated?: boolean;
  success: boolean;
  error?: string;
}

export interface UsageScope {
  db?: Db;
  staffId?: string | null;
  source?: UsageSource;
  documentId?: string | null;
  jobId?: number | null;
  /** Also told about every call (the eval totals its own usage this way). */
  listener?: (call: LlmCall & { costUsd: number }) => void;
}

const store = new AsyncLocalStorage<UsageScope>();

/** Runs `fn` with this usage context, layered over the current one. */
export function usageScope<T>(scope: UsageScope, fn: () => T): T {
  return store.run({ ...store.getStore(), ...scope }, fn);
}

/** A rough token count for offline models (no tokenizer): about four characters a token. */
export function estimateTokens(texts: string[]): number {
  return Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
}

/** Records one model call. Never throws: losing a usage row must not fail an extraction. */
export async function reportCall(call: LlmCall): Promise<void> {
  const scope = store.getStore();
  if (!scope) return;
  const { usd } = estimateCost(call.model, call.inputTokens, call.outputTokens);
  scope.listener?.({ ...call, costUsd: usd });
  if (!scope.db) return;
  try {
    await scope.db.query(
      `insert into llm_calls (staff_id, source, operation, provider, model, input_tokens, output_tokens, tokens_estimated,
                              cost_usd, latency_ms, escalated, success, error, document_id, job_id, firm_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               (select id from documents where id = $14 and firm_id = $16), (select id from jobs where id = $15 and firm_id = $16),
               $16)`,
      [
        scope.staffId ?? null,
        scope.source ?? 'script',
        call.operation,
        call.provider,
        call.model,
        Math.max(0, Math.round(call.inputTokens)),
        Math.max(0, Math.round(call.outputTokens)),
        call.tokensEstimated ?? false,
        usd,
        Math.max(0, Math.round(call.latencyMs)),
        call.escalated ?? false,
        call.success,
        call.error ? call.error.slice(0, 80) : null,
        scope.documentId ?? null,
        scope.jobId ?? null,
        firmOf(scope.db),
      ],
    );
  } catch (error) {
    console.error('Could not record LLM usage:', error instanceof Error ? error.message : error);
  }
}

/**
 * What went wrong, without what the model said: provider errors can echo a partial answer (Groq's
 * `failed_generation` holds the extracted values), so only the part before the first colon is kept,
 * e.g. "Groq 400" or "openai/gpt-oss-20b returned output that was not JSON".
 */
export function errorCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(':')[0]!.trim().slice(0, 80);
}

/** Times `fn` and reports it; failures are reported too, then rethrown. */
export async function timedCall<T>(
  base: Omit<LlmCall, 'latencyMs' | 'success' | 'error' | 'inputTokens' | 'outputTokens'>,
  fn: () => Promise<T>,
  tokens: (result: T) => { inputTokens: number; outputTokens: number; tokensEstimated?: boolean },
  tokensOnError: { inputTokens: number; outputTokens: number; tokensEstimated?: boolean } = {
    inputTokens: 0,
    outputTokens: 0,
  },
): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    await reportCall({ ...base, ...tokens(result), latencyMs: performance.now() - started, success: true });
    return result;
  } catch (error) {
    await reportCall({
      ...base,
      ...tokensOnError,
      latencyMs: performance.now() - started,
      success: false,
      error: errorCategory(error),
    });
    throw error;
  }
}
