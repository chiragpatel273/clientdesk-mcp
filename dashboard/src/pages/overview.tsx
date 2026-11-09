import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckSquare, FileCheck2, FolderCheck, Gauge, Inbox, ScrollText } from 'lucide-react';
import { Link } from 'react-router';
import { api, isApiError, type Stats } from '../api';
import { AuditTable } from '../components/audit-table';
import { MetricTile, MetricTileSkeleton } from '../components/metric-tile';
import { PageHeader } from '../components/page-header';
import { StatTile } from '../components/stat-tile';
import { EmptyState, ErrorState } from '../components/states';
import { buttonVariants } from '../components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { formatInt, formatRelative } from '../lib/format';
import { useSession } from '../lib/session';
import { cn } from '../lib/utils';

export function OverviewPage() {
  const { isPartner } = useSession();
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 30_000 });

  return (
    <>
      <PageHeader
        title="Overview"
        description="Documents waiting, today's activity through Claude, and how accurate the system is."
      />

      {stats.isError ? (
        <Card className="mb-6">
          <ErrorState error={stats.error} onRetry={() => void stats.refetch()} title="Could not load the numbers" />
        </Card>
      ) : (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <StatTile
            label="Inbox"
            value={stats.data?.documents.inbox}
            icon={Inbox}
            to="/inbox"
            hint="Not yet processed"
          />
          <StatTile
            label="Needs review"
            value={stats.data?.documents.review}
            icon={FileCheck2}
            to="/review"
            hint="Sent to a person, not guessed"
            emphasis="warn"
          />
          <StatTile label="Filed" value={stats.data?.documents.filed} icon={FolderCheck} hint="Matched to a client" />
          <StatTile label="Open items" value={stats.data?.openItems} icon={CheckSquare} hint="Missing from clients" />
        </div>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <ToolCallsCard stats={stats.data} isPartner={isPartner} />
        <AccuracySummary />
      </div>

      <RecentActivity />
    </>
  );
}

/** Today's tool calls as one whole split into outcomes (a thin segmented bar), with the counts printed. */
function ToolCallsCard({ stats, isPartner }: { stats: Stats | undefined; isPartner: boolean }) {
  const calls = stats?.toolCallsToday;
  const total = calls ? calls.ok + calls.denied + calls.error : 0;
  const parts = [
    { key: 'ok', label: 'OK', value: calls?.ok ?? 0, bar: 'bg-ok', dot: 'bg-ok' },
    { key: 'denied', label: 'Denied', value: calls?.denied ?? 0, bar: 'bg-warn', dot: 'bg-warn' },
    { key: 'error', label: 'Error', value: calls?.error ?? 0, bar: 'bg-danger', dot: 'bg-danger' },
  ] as const;

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Tool calls today</CardTitle>
        <CardDescription>{isPartner ? 'Every staff member, every call.' : 'Your calls.'}</CardDescription>
      </CardHeader>
      <div className="flex flex-1 flex-col justify-end gap-4 px-5 pb-5">
        {calls === undefined ? (
          <>
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-2 w-full" />
          </>
        ) : (
          <>
            <p className="text-3xl font-semibold tracking-tight">{formatInt(total)}</p>
            <div
              className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}
            >
              {parts.map((p) =>
                p.value > 0 ? (
                  <div key={p.key} className={cn('h-full rounded-full', p.bar)} style={{ flexGrow: p.value }} />
                ) : null,
              )}
            </div>
            <dl className="grid grid-cols-3 gap-2">
              {parts.map((p) => (
                <div key={p.key}>
                  <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={cn('size-2 rounded-full', p.dot)} aria-hidden />
                    {p.label}
                  </dt>
                  <dd className="text-lg font-semibold tabular-nums">{formatInt(p.value)}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </Card>
  );
}

function AccuracySummary() {
  const report = useQuery({ queryKey: ['accuracy'], queryFn: api.accuracy, staleTime: 5 * 60_000 });

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>Accuracy</CardTitle>
          <CardDescription>
            {report.data
              ? `Measured on ${formatInt(report.data.dataset.documents)} labelled documents, ${formatRelative(report.data.generatedAt)}.`
              : 'Measured on a labelled test set, published even when a target is missed.'}
          </CardDescription>
        </div>
        <Link to="/accuracy" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-mr-2 shrink-0')}>
          Report <ArrowRight />
        </Link>
      </CardHeader>
      <div className="px-5 pb-5">
        {report.isPending ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <MetricTileSkeleton key={i} />
            ))}
          </div>
        ) : report.isError ? (
          isApiError(report.error, 404) ? (
            <EmptyState icon={Gauge} title="No accuracy report yet" className="py-6">
              Run <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">npm run eval</code> to generate the
              first report.
            </EmptyState>
          ) : (
            <ErrorState error={report.error} onRetry={() => void report.refetch()} className="py-6" />
          )
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {report.data.metrics.map((m) => (
              <MetricTile key={m.key} metric={m} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function RecentActivity() {
  const audit = useQuery({
    queryKey: ['audit', 'recent'],
    queryFn: () => api.audit({ limit: 10 }),
    refetchInterval: 15_000,
  });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>Latest activity</CardTitle>
          <CardDescription>
            Every tool call Claude makes is written to the audit log, including refusals.
          </CardDescription>
        </div>
        <Link to="/audit" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-mr-2 shrink-0')}>
          <ScrollText /> Audit log
        </Link>
      </CardHeader>
      {audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : (
        <AuditTable rows={audit.data?.rows} loading={audit.isPending} compact />
      )}
    </Card>
  );
}
