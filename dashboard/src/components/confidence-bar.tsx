import { formatPercent } from '../lib/format';
import { cn } from '../lib/utils';

/** Low / medium / high bands used across the review queue. */
export function confidenceBand(value: number): 'high' | 'medium' | 'low' {
  if (value >= 0.9) return 'high';
  if (value >= 0.7) return 'medium';
  return 'low';
}

const fill = { high: 'bg-ok', medium: 'bg-warn', low: 'bg-danger' } as const;
const track = { high: 'bg-ok-soft', medium: 'bg-warn-soft', low: 'bg-danger-soft' } as const;

/** A thin meter plus the number. The percentage is always printed, so the colour never carries meaning alone. */
export function ConfidenceBar({ value, label, className }: { value: number; label?: string; className?: string }) {
  const v = Math.min(1, Math.max(0, value));
  const band = confidenceBand(v);
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        aria-label={label ?? 'Confidence'}
        className={cn('h-1.5 min-w-12 flex-1 overflow-hidden rounded-full', track[band])}
      >
        <div className={cn('h-full rounded-full', fill[band])} style={{ width: `${v * 100}%` }} />
      </div>
      <span className="w-11 text-right text-xs font-medium text-muted-foreground tabular-nums">
        {formatPercent(v, 0)}
      </span>
    </div>
  );
}
