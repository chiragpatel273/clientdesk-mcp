import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { formatInt } from '../lib/format';
import { cn } from '../lib/utils';
import { Skeleton } from './ui/skeleton';

export function StatTile({
  label,
  value,
  icon: Icon,
  to,
  hint,
  emphasis,
}: {
  label: string;
  value: number | undefined;
  icon: LucideIcon;
  to?: string;
  hint?: ReactNode;
  emphasis?: 'warn';
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <Icon className={cn('size-4 text-muted-foreground', emphasis === 'warn' && value ? 'text-warn' : '')} />
      </div>
      {value === undefined ? (
        <Skeleton className="mt-1 h-8 w-16" />
      ) : (
        <p className="text-3xl font-semibold tracking-tight">{formatInt(value)}</p>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </>
  );
  const className = 'flex flex-col gap-1.5 rounded-xl border bg-card p-4 shadow-xs';
  return to ? (
    <Link to={to} className={cn(className, 'transition-colors hover:border-primary/40 hover:bg-muted/40')}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
