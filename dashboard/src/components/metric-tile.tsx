import type { AccuracyMetric } from '../api';
import { formatInt, formatPercent } from '../lib/format';
import { cn } from '../lib/utils';
import { PassBadge } from './outcome-badge';
import { Skeleton } from './ui/skeleton';

export function formatMetricValue(m: Pick<AccuracyMetric, 'unit'>, value: number): string {
  return m.unit === 'percent' ? formatPercent(value) : formatInt(value);
}

/** One accuracy metric: value, target with its direction, and pass / miss. */
export function MetricTile({ metric }: { metric: AccuracyMetric }) {
  const op = metric.op === '>=' ? '≥' : '≤';
  return (
    <div
      className={cn('flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-xs', !metric.pass && 'border-danger/40')}
    >
      <p className="text-[13px] leading-snug font-medium text-muted-foreground">{metric.label}</p>
      <p className="text-2xl font-semibold tracking-tight">{formatMetricValue(metric, metric.value)}</p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="text-xs text-muted-foreground">
          Target {op} {formatMetricValue(metric, metric.target)}
        </p>
        <PassBadge pass={metric.pass} />
      </div>
    </div>
  );
}

export function MetricTileSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-7 w-1/2" />
      <Skeleton className="h-3 w-1/3" />
    </div>
  );
}
