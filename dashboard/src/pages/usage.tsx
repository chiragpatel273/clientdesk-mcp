import { useQuery } from '@tanstack/react-query';
import { Coins } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, isApiError, type Usage } from '../api';
import { PageHeader } from '../components/page-header';
import { EmptyState, ErrorState } from '../components/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs } from '../components/ui/tabs';
import { formatDateTime, formatInt, formatPercent, humanize } from '../lib/format';

type Measure = 'calls' | 'tokens' | 'costUsd';
const MEASURES: { value: Measure; label: string }[] = [
  { value: 'calls', label: 'Calls' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'costUsd', label: 'Cost' },
];

/** Small costs need more digits: $0.0042 is meaningful, $0.00 isn't. */
function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

const formatMeasure = (m: Measure, v: number) => (m === 'costUsd' ? formatUsd(v) : formatInt(v));

export function UsagePage() {
  const [days, setDays] = useState<'7' | '14' | '30'>('14');
  const usage = useQuery({
    queryKey: ['usage', days],
    queryFn: () => api.usage(Number(days)),
    refetchInterval: 30_000,
  });

  return (
    <>
      <PageHeader
        title="LLM usage"
        description="Every model call ClientDesk makes (extraction and embeddings), with tokens, estimated cost and latency. No document text is stored."
      />
      <Tabs
        label="Period"
        className="mb-6"
        value={days}
        onChange={setDays}
        options={[
          { value: '7', label: '7 days' },
          { value: '14', label: '14 days' },
          { value: '30', label: '30 days' },
        ]}
      />
      {usage.isPending ? (
        <div className="grid gap-4" aria-busy="true" aria-label="Loading usage">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : usage.isError ? (
        <Card>
          <ErrorState
            title={isApiError(usage.error, 403) ? 'Partners only' : undefined}
            error={usage.error}
            onRetry={() => void usage.refetch()}
          />
        </Card>
      ) : (
        <UsageReport usage={usage.data} />
      )}
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-4 shadow-xs">
      <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function UsageReport({ usage }: { usage: Usage }) {
  const t = usage.totals;
  const [measure, setMeasure] = useState<Measure>('calls');
  const offline = t.estimatedTokenShare > 0.5;

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="usage-tiles">
        <Tile label="Model calls" value={formatInt(t.calls)} hint={`last ${usage.days} days`} />
        <Tile
          label="Tokens"
          value={formatInt(t.inputTokens + t.outputTokens)}
          hint={`${formatInt(t.inputTokens)} in · ${formatInt(t.outputTokens)} out${offline ? ' · mostly estimated' : ''}`}
        />
        <Tile label="Estimated cost" value={formatUsd(t.costUsd)} hint="from the price table in src/ai/prices.ts" />
        <Tile
          label="Cost per filed document"
          value={t.costPerFiledDocument === null ? '–' : formatUsd(t.costPerFiledDocument)}
          hint={`${formatInt(t.filedDocuments)} documents filed`}
        />
        <Tile label="Average latency" value={`${formatInt(t.avgLatencyMs)} ms`} />
        <Tile label="Escalation rate" value={formatPercent(t.escalationRate)} hint="larger model's second look" />
        <Tile label="Error rate" value={formatPercent(t.errorRate)} hint="failed model calls" />
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{MEASURES.find((m) => m.value === measure)!.label} per day</CardTitle>
            <CardDescription>UTC days, all models together.</CardDescription>
          </div>
          <Tabs label="Measure" value={measure} onChange={setMeasure} options={MEASURES} />
        </CardHeader>
        <CardContent>
          {usage.byDay.length === 0 ? (
            <EmptyState icon={Coins} title="No model calls in this period" />
          ) : (
            <DayChart rows={usage.byDay} measure={measure} />
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>By model</CardTitle>
          <CardDescription>
            Offline models (rules-v1, local-hash-v1) cost nothing; their token counts are character estimates.
          </CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Operation</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Input tokens</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Output tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="hidden text-right md:table-cell">Avg latency</TableHead>
              <TableHead className="hidden text-right md:table-cell">Errors</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usage.byModel.map((m) => (
              <TableRow key={`${m.operation}-${m.model}`}>
                <TableCell>
                  <span className="font-mono text-xs">{m.model}</span>
                  <span className="block text-xs text-muted-foreground">{m.provider}</span>
                </TableCell>
                <TableCell>{humanize(m.operation)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(m.calls)}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">
                  {formatInt(m.inputTokens)}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">
                  {formatInt(m.outputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatUsd(m.costUsd)}</TableCell>
                <TableCell className="hidden text-right tabular-nums md:table-cell">
                  {formatInt(m.avgLatencyMs)} ms
                </TableCell>
                <TableCell className="hidden text-right tabular-nums md:table-cell">{formatInt(m.errors)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Where the calls come from</CardTitle>
            <CardDescription>Claude (MCP tools), the dashboard, background jobs and start-up.</CardDescription>
          </CardHeader>
          <Table>
            <TableBody>
              {usage.bySource.map((s) => (
                <TableRow key={s.source}>
                  <TableCell>{humanize(s.source)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(s.calls)} calls</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(s.costUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Accuracy runs</CardTitle>
            <CardDescription>The eval runs in its own process; its model usage is in each report.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {usage.evalRuns.length === 0 && <p className="text-muted-foreground">No accuracy reports yet.</p>}
            {usage.evalRuns.map((r) => (
              <div key={r.run} className="rounded-lg border px-3 py-2" data-testid={`eval-usage-${r.run}`}>
                <p className="font-medium">{r.run === 'report' ? 'Latest model run' : 'Offline baseline (CI)'}</p>
                <p className="text-xs text-muted-foreground">
                  {r.extractor}
                  {r.generatedAt ? ` · ${formatDateTime(r.generatedAt)}` : ''}
                </p>
                <p className="mt-1 tabular-nums">
                  {r.usage
                    ? `${formatInt(r.usage.calls)} calls · ${formatInt(r.usage.inputTokens + r.usage.outputTokens)} tokens · ${formatUsd(r.usage.costUsd)}`
                    : 'Not recorded (report made before usage tracking).'}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** One measure at a time (no second axis): one series, one hue, no legend; the title names it. */
function DayChart({ rows, measure }: { rows: Usage['byDay']; measure: Measure }) {
  return (
    <div style={{ height: 240 }} className="w-full text-xs">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 4 }} barCategoryGap={8}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="day"
            tickFormatter={(d: string) => d.slice(5)}
            tick={{ fill: 'var(--muted-foreground)' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            width={64}
            tickFormatter={(v: number) => formatMeasure(measure, v)}
            tick={{ fill: 'var(--muted-foreground)' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: 'var(--muted)', opacity: 0.6 }}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as Usage['byDay'][number] | undefined;
              if (!active || !row) return null;
              return (
                <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
                  <p className="mb-1 font-medium">{row.day}</p>
                  {MEASURES.map((m) => (
                    <p key={m.value} className="text-muted-foreground">
                      {m.label}{' '}
                      <span className="font-medium text-foreground tabular-nums">
                        {formatMeasure(m.value, row[m.value])}
                      </span>
                    </p>
                  ))}
                </div>
              );
            }}
          />
          <Bar
            dataKey={measure}
            fill="var(--chart-1)"
            radius={[4, 4, 0, 0]}
            maxBarSize={40}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
