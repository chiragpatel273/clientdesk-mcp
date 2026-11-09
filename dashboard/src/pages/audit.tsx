import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Loader2, RotateCw, X } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { api, type Outcome } from '../api';
import { AuditTable } from '../components/audit-table';
import { PageHeader } from '../components/page-header';
import { ErrorState, InlineError } from '../components/states';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { formatInt } from '../lib/format';
import { useSession } from '../lib/session';

const PAGE_SIZE = 50;
const OUTCOMES: Outcome[] = ['ok', 'denied', 'error'];

function parseOutcome(value: string | null): Outcome | null {
  return OUTCOMES.includes(value as Outcome) ? (value as Outcome) : null;
}

export function AuditPage() {
  const { isPartner } = useSession();
  const [params, setParams] = useSearchParams();
  const outcome = parseOutcome(params.get('outcome'));
  const tool = params.get('tool') || null;

  const audit = useInfiniteQuery({
    queryKey: ['audit', 'log', { outcome, tool }],
    queryFn: ({ pageParam }) => api.audit({ limit: PAGE_SIZE, before: pageParam, outcome, tool }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => audit.data?.pages.flatMap((p) => p.rows), [audit.data]);
  const tools = useMemo(() => {
    const fromServer = audit.data?.pages[0]?.tools ?? [];
    // Keep the selected tool in the list even if the server's list doesn't include it.
    return tool && !fromServer.includes(tool) ? [...fromServer, tool] : fromServer;
  }, [audit.data, tool]);

  const setFilter = (key: 'outcome' | 'tool', value: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  const filtered = outcome !== null || tool !== null;

  return (
    <>
      <PageHeader
        title="Audit log"
        description={
          isPartner
            ? 'Every tool call by every staff member: who asked, what ran, and whether it was allowed.'
            : 'Every tool call you have made: what ran and whether it was allowed. Partners see the whole firm.'
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => void audit.refetch()} disabled={audit.isFetching}>
            <RotateCw className={audit.isRefetching && !audit.isFetchingNextPage ? 'animate-spin' : ''} /> Refresh
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex w-40 flex-col gap-1.5">
          <Label htmlFor="filter-outcome">Outcome</Label>
          <Select id="filter-outcome" value={outcome ?? ''} onChange={(e) => setFilter('outcome', e.target.value)}>
            <option value="">All outcomes</option>
            <option value="ok">OK</option>
            <option value="denied">Denied</option>
            <option value="error">Error</option>
          </Select>
        </div>
        <div className="flex w-52 flex-col gap-1.5">
          <Label htmlFor="filter-tool">Tool</Label>
          <Select id="filter-tool" value={tool ?? ''} onChange={(e) => setFilter('tool', e.target.value)}>
            <option value="">All tools</option>
            {tools.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" className="mb-0.5" onClick={() => setParams({}, { replace: true })}>
            <X /> Clear filters
          </Button>
        )}
      </div>

      <Card className="overflow-hidden">
        {audit.isError && !audit.data ? (
          <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
        ) : (
          <div className={audit.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
            <AuditTable
              rows={rows}
              loading={audit.isPending}
              emptyHint={filtered ? 'No calls match these filters.' : undefined}
            />
          </div>
        )}
      </Card>

      {rows && rows.length > 0 && (
        <div className="mt-4 flex flex-col items-center gap-3">
          {audit.isFetchNextPageError && <InlineError>Could not load more rows: {audit.error?.message}</InlineError>}
          <p className="text-xs text-muted-foreground">
            Showing {formatInt(rows.length)} {rows.length === 1 ? 'call' : 'calls'}
            {audit.hasNextPage ? '' : filtered ? ', all that match' : ', back to the first entry'}
          </p>
          {audit.hasNextPage && (
            <Button variant="outline" onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
              {audit.isFetchingNextPage && <Loader2 className="animate-spin" />}
              Load more
            </Button>
          )}
        </div>
      )}
    </>
  );
}
