import type { Db } from '../db/index.js';

export interface UsageSummary {
  days: number;
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    avgLatencyMs: number;
    /** Extraction calls that were the larger model's second look, per first look. */
    escalationRate: number;
    errorRate: number;
    filedDocuments: number;
    /** Cost of the period divided by the documents filed in it; null when nothing was filed. */
    costPerFiledDocument: number | null;
    /** Share of the tokens that are character estimates (offline models), not counts from an API. */
    estimatedTokenShare: number;
  };
  byDay: { day: string; calls: number; tokens: number; costUsd: number }[];
  byModel: {
    operation: string;
    provider: string;
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    avgLatencyMs: number;
    errors: number;
  }[];
  bySource: { source: string; calls: number; costUsd: number }[];
}

const n = (v: unknown) => Number(v ?? 0);

/** LLM usage over the last `days` days (UTC), for the partners' Usage page. */
export async function usageSummary(db: Db, days: number): Promise<UsageSummary> {
  const since = `now() - make_interval(days => $1)`;
  const [t] = await db.query<Record<string, unknown>>(
    `select count(*)::int as calls, coalesce(sum(input_tokens), 0)::bigint as input_tokens,
            coalesce(sum(output_tokens), 0)::bigint as output_tokens, coalesce(sum(cost_usd), 0)::float8 as cost,
            coalesce(avg(latency_ms), 0)::float8 as latency,
            count(*) filter (where operation = 'extract' and escalated)::int as escalated,
            count(*) filter (where operation = 'extract' and not escalated)::int as first_looks,
            count(*) filter (where not success)::int as errors,
            coalesce(sum(input_tokens + output_tokens) filter (where tokens_estimated), 0)::bigint as estimated
     from llm_calls where at >= ${since}`,
    [days],
  );
  const [filed] = await db.query<{ n: number }>(
    `select count(*)::int as n from documents where status = 'filed' and filed_at >= ${since}`,
    [days],
  );
  const byDay = await db.query<{ day: string; calls: number; tokens: number; cost: number }>(
    `select to_char(date_trunc('day', at at time zone 'UTC'), 'YYYY-MM-DD') as day, count(*)::int as calls,
            sum(input_tokens + output_tokens)::bigint as tokens, sum(cost_usd)::float8 as cost
     from llm_calls where at >= ${since} group by 1 order by 1`,
    [days],
  );
  const byModel = await db.query<Record<string, unknown>>(
    `select operation, provider, model, count(*)::int as calls, sum(input_tokens)::bigint as input_tokens,
            sum(output_tokens)::bigint as output_tokens, sum(cost_usd)::float8 as cost, avg(latency_ms)::float8 as latency,
            count(*) filter (where not success)::int as errors
     from llm_calls where at >= ${since} group by 1, 2, 3 order by cost desc, calls desc`,
    [days],
  );
  const bySource = await db.query<{ source: string; calls: number; cost: number }>(
    `select source, count(*)::int as calls, sum(cost_usd)::float8 as cost
     from llm_calls where at >= ${since} group by 1 order by calls desc`,
    [days],
  );

  const calls = n(t?.calls);
  const tokens = n(t?.input_tokens) + n(t?.output_tokens);
  const cost = n(t?.cost);
  const filedDocuments = n(filed?.n);
  return {
    days,
    totals: {
      calls,
      inputTokens: n(t?.input_tokens),
      outputTokens: n(t?.output_tokens),
      costUsd: cost,
      avgLatencyMs: Math.round(n(t?.latency)),
      escalationRate: n(t?.first_looks) ? n(t?.escalated) / n(t?.first_looks) : 0,
      errorRate: calls ? n(t?.errors) / calls : 0,
      filedDocuments,
      costPerFiledDocument: filedDocuments ? cost / filedDocuments : null,
      estimatedTokenShare: tokens ? n(t?.estimated) / tokens : 0,
    },
    byDay: byDay.map((d) => ({ day: d.day, calls: n(d.calls), tokens: n(d.tokens), costUsd: n(d.cost) })),
    byModel: byModel.map((m) => ({
      operation: String(m.operation),
      provider: String(m.provider),
      model: String(m.model),
      calls: n(m.calls),
      inputTokens: n(m.input_tokens),
      outputTokens: n(m.output_tokens),
      costUsd: n(m.cost),
      avgLatencyMs: Math.round(n(m.latency)),
      errors: n(m.errors),
    })),
    bySource: bySource.map((s) => ({ source: s.source, calls: n(s.calls), costUsd: n(s.cost) })),
  };
}
