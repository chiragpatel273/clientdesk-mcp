import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { ChevronRight, ScrollText } from 'lucide-react';
import { Fragment, useMemo } from 'react';
import type { AuditRow } from '../api';
import { formatDateTime, formatDuration, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import { OutcomeBadge } from './outcome-badge';
import { EmptyState } from './states';
import { Skeleton } from './ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    className?: string;
  }
}

const col = createColumnHelper<AuditRow>();

const columns = [
  col.display({
    id: 'expand',
    header: () => <span className="sr-only">Expand</span>,
    cell: ({ row }) => (
      <ChevronRight
        aria-hidden
        className={cn('size-4 text-muted-foreground transition-transform', row.getIsExpanded() && 'rotate-90')}
      />
    ),
    meta: { className: 'w-8 pr-0' },
  }),
  col.accessor('at', {
    header: 'Time',
    cell: (c) => (
      <time dateTime={c.getValue()} title={formatDateTime(c.getValue())} className="whitespace-nowrap tabular-nums">
        {formatWhen(c.getValue())}
      </time>
    ),
  }),
  col.accessor((r) => r.staff?.name ?? 'Unknown', {
    id: 'staff',
    header: 'Staff member',
    cell: (c) => <span className="whitespace-nowrap">{c.getValue()}</span>,
  }),
  col.accessor('tool', {
    header: 'Tool',
    cell: (c) => <code className="font-mono text-[13px] whitespace-nowrap">{c.getValue()}</code>,
  }),
  col.accessor('outcome', {
    header: 'Outcome',
    cell: (c) => <OutcomeBadge outcome={c.getValue()} />,
  }),
  col.accessor('durationMs', {
    header: 'Duration',
    cell: (c) => (
      <span className="whitespace-nowrap text-muted-foreground tabular-nums">{formatDuration(c.getValue())}</span>
    ),
    meta: { className: 'hidden text-right md:table-cell' },
  }),
  col.accessor('detail', {
    header: 'Detail',
    cell: (c) => <span className="line-clamp-1 text-muted-foreground">{c.getValue() ?? '–'}</span>,
    meta: { className: 'hidden w-full min-w-48 lg:table-cell' },
  }),
];

function prettyJson(value: unknown): string {
  if (value === undefined) return 'No input recorded.';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The audit log as a table. Click a row to see its full detail and the (masked) input the tool received. */
export function AuditTable({
  rows,
  loading,
  compact,
  emptyHint,
}: {
  rows: AuditRow[] | undefined;
  loading?: boolean;
  compact?: boolean;
  emptyHint?: string;
}) {
  const data = useMemo(() => rows ?? [], [rows]);
  const table = useReactTable({
    data,
    columns,
    getRowId: (r) => String(r.id),
    getRowCanExpand: () => true,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  if (loading) {
    return (
      <div className="flex flex-col gap-3 px-5 py-4" aria-busy="true" aria-label="Loading audit log">
        {Array.from({ length: compact ? 5 : 8 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <EmptyState icon={ScrollText} title="No tool calls yet">
        {emptyHint ?? 'Calls appear here as soon as someone uses ClientDesk from Claude.'}
      </EmptyState>
    );
  }

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((hg) => (
          <TableRow key={hg.id}>
            {hg.headers.map((h) => (
              <TableHead key={h.id} className={h.column.columnDef.meta?.className}>
                {flexRender(h.column.columnDef.header, h.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => {
          const r = row.original;
          const denied = r.outcome === 'denied';
          const toggle = row.getToggleExpandedHandler();
          return (
            <Fragment key={row.id}>
              <TableRow
                onClick={toggle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle();
                  }
                }}
                tabIndex={0}
                aria-expanded={row.getIsExpanded()}
                className={cn(
                  'cursor-pointer hover:bg-muted/50',
                  denied && 'bg-warn-soft/45 shadow-[inset_3px_0_0_var(--color-warn)] hover:bg-warn-soft/70',
                  r.outcome === 'error' && 'shadow-[inset_3px_0_0_var(--color-danger)]',
                  row.getIsExpanded() && 'border-b-0',
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
              {row.getIsExpanded() && (
                <TableRow className={cn(denied && 'bg-warn-soft/45 shadow-[inset_3px_0_0_var(--color-warn)]')}>
                  <TableCell colSpan={row.getVisibleCells().length} className="pt-0 pb-4">
                    <div className="grid w-0 min-w-full gap-3 rounded-lg border bg-muted/40 p-3 text-[13px] sm:p-4">
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                        <dt className="text-muted-foreground">When</dt>
                        <dd className="tabular-nums">{formatDateTime(r.at)}</dd>
                        <dt className="text-muted-foreground">Duration</dt>
                        <dd className="tabular-nums">{formatDuration(r.durationMs)}</dd>
                        <dt className="text-muted-foreground">Detail</dt>
                        <dd className="break-words whitespace-pre-wrap">{r.detail ?? '–'}</dd>
                        <dt className="text-muted-foreground">Log id</dt>
                        <dd className="tabular-nums">#{r.id}</dd>
                      </dl>
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          Input (sensitive fields are masked before they are stored)
                        </p>
                        <pre className="max-h-72 overflow-auto rounded-md border bg-card p-3 font-mono text-xs leading-relaxed">
                          {prettyJson(r.input)}
                        </pre>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
