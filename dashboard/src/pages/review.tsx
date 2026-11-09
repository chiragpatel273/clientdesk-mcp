import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CircleCheck,
  ExternalLink,
  FileCheck2,
  FolderInput,
  Loader2,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, openDocument, type ReviewItem } from '../api';
import { confidenceBand, ConfidenceBar } from '../components/confidence-bar';
import { PageHeader } from '../components/page-header';
import { EmptyState, ErrorState, InlineError } from '../components/states';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '../components/ui/card';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Skeleton } from '../components/ui/skeleton';
import { formatDateTime, formatPercent, formatRelative, humanize } from '../lib/format';
import { useSession } from '../lib/session';
import { cn } from '../lib/utils';
import { Tooltip } from '../components/ui/tooltip';

export function ReviewPage() {
  const review = useQuery({ queryKey: ['review'], queryFn: api.review, refetchInterval: 30_000 });
  const [justFiled, setJustFiled] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Documents Claude was not sure about. They wait here for a person instead of being filed on a guess."
      />

      {justFiled && (
        <p
          role="status"
          className="mb-4 flex items-center gap-2 rounded-lg border border-ok/30 bg-ok-soft px-3 py-2 text-sm text-ok"
        >
          <CircleCheck className="size-4 shrink-0" /> {justFiled}
        </p>
      )}

      {review.isPending ? (
        <div className="grid gap-4">
          {Array.from({ length: 2 }, (_, i) => (
            <Card key={i} className="p-5">
              <Skeleton className="mb-3 h-5 w-1/3" />
              <Skeleton className="mb-5 h-4 w-2/3" />
              <div className="grid gap-4 md:grid-cols-2">
                <Skeleton className="h-32" />
                <Skeleton className="h-32" />
              </div>
            </Card>
          ))}
        </div>
      ) : review.isError ? (
        <Card>
          <ErrorState error={review.error} onRetry={() => void review.refetch()} />
        </Card>
      ) : review.data.items.length === 0 ? (
        <Card>
          <EmptyState icon={FileCheck2} title="Nothing waiting for review">
            When a document is unclear or matches more than one client, Claude sends it here with a reason.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4">
          {review.data.items.map((item) => (
            <ReviewCard key={item.id} item={item} onFiled={(msg) => setJustFiled(msg)} />
          ))}
        </div>
      )}
    </>
  );
}

function ReviewCard({ item, onFiled }: { item: ReviewItem; onFiled: (message: string) => void }) {
  const { isPartner } = useSession();
  const [resolving, setResolving] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const docType = item.extraction?.docType ?? item.docType;
  const candidates = [...item.candidates].sort((a, b) => b.confidence - a.confidence);

  const view = async () => {
    setOpenError(null);
    try {
      await openDocument(item.id);
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : 'Could not open the document.');
    }
  };

  const fileButton = (
    <Button size="sm" onClick={() => setResolving(true)} disabled={!isPartner || candidates.length === 0}>
      <FolderInput /> File to client
    </Button>
  );

  return (
    <Card>
      <CardHeader className="gap-3 pb-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold tracking-tight">{item.title}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {item.filename && <span className="max-w-full truncate font-mono">{item.filename}</span>}
              <time dateTime={item.receivedAt} title={formatDateTime(item.receivedAt)}>
                Received {formatRelative(item.receivedAt)}
              </time>
              {item.sentBy && (
                <span className="inline-flex items-center gap-1">
                  <UserRound className="size-3" aria-hidden /> Sent by {item.sentBy.name}
                </span>
              )}
            </p>
          </div>
          {docType && (
            <Badge variant="outline" className="self-start">
              {humanize(docType)}
            </Badge>
          )}
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <p>
            <span className="font-medium">Why it is here: </span>
            {item.reviewReason ?? 'No reason was recorded.'}
          </p>
        </div>
      </CardHeader>

      <CardContent className="grid gap-6 md:grid-cols-2">
        <section aria-label="Extracted fields">
          <h3 className="mb-2 flex items-center justify-between gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Extracted fields
            {item.extraction && (
              <span className="inline-flex items-center gap-1 font-mono text-[11px] tracking-normal normal-case">
                <Sparkles className="size-3" /> {item.extraction.model}
              </span>
            )}
          </h3>
          {!item.extraction || item.extraction.fields.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
              No fields were extracted from this document.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {item.extraction.fields.map((f) => {
                const low = confidenceBand(f.confidence) === 'low';
                return (
                  <li key={f.name} className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        {humanize(f.name)}
                        {low && <span className="sr-only"> (low confidence)</span>}
                      </p>
                      <p className={cn('text-sm break-words', f.value === null && 'text-muted-foreground italic')}>
                        {f.value ?? 'Not found'}
                      </p>
                    </div>
                    <ConfidenceBar value={f.confidence} label={`${humanize(f.name)} confidence`} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Candidate clients">
          <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Candidate clients</h3>
          {candidates.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
              No client matched this document.
            </p>
          ) : (
            <ul className="grid gap-2">
              {candidates.map((c) => (
                <li key={c.clientId} className="rounded-lg border px-3 py-2.5">
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-medium">{c.name}</p>
                    <code className="shrink-0 font-mono text-[11px] text-muted-foreground">{c.clientId}</code>
                  </div>
                  <ConfidenceBar value={c.confidence} label={`Match confidence for ${c.name}`} />
                  {c.reasons.length > 0 && (
                    <ul className="mt-2 grid gap-0.5 text-xs text-muted-foreground">
                      {c.reasons.map((r, i) => (
                        <li key={i} className="flex gap-1.5">
                          <span aria-hidden>–</span>
                          {r}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>

      <CardFooter className="flex-wrap justify-end">
        {openError && <p className="mr-auto text-sm text-danger">{openError}</p>}
        <Button variant="outline" size="sm" onClick={() => void view()}>
          <ExternalLink /> View document
        </Button>
        {isPartner ? (
          candidates.length === 0 ? (
            <Tooltip content="No candidate clients to file to" align="end">
              {fileButton}
            </Tooltip>
          ) : (
            fileButton
          )
        ) : (
          <Tooltip content="Only partners can resolve reviews" align="end">
            {fileButton}
          </Tooltip>
        )}
      </CardFooter>

      {isPartner && (
        <ResolveDialog
          item={item}
          open={resolving}
          onClose={() => setResolving(false)}
          onDone={(clientName) => {
            setResolving(false);
            onFiled(`“${item.title}” was filed to ${clientName}.`);
          }}
        />
      )}
    </Card>
  );
}

function ResolveDialog({
  item,
  open,
  onClose,
  onDone,
}: {
  item: ReviewItem;
  open: boolean;
  onClose: () => void;
  onDone: (clientName: string) => void;
}) {
  const queryClient = useQueryClient();
  const candidates = [...item.candidates].sort((a, b) => b.confidence - a.confidence);
  // Deliberately no pre-selection: the partner picks the client, nothing is chosen for them.
  const [clientId, setClientId] = useState<string>('');
  const [taxYear, setTaxYear] = useState('');

  const year = taxYear.trim() === '' ? undefined : Number(taxYear);
  const yearInvalid = year !== undefined && (!Number.isInteger(year) || year < 1990 || year > 2100);

  const resolve = useMutation({
    mutationFn: () => api.resolveReview(item.id, { clientId, ...(year !== undefined ? { taxYear: year } : {}) }),
    onSuccess: () => {
      const name = candidates.find((c) => c.clientId === clientId)?.name ?? clientId;
      void queryClient.invalidateQueries({ queryKey: ['review'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      void queryClient.invalidateQueries({ queryKey: ['audit'] });
      onDone(name);
    },
  });

  const close = () => {
    if (resolve.isPending) return;
    resolve.reset();
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!clientId || yearInvalid) return;
    resolve.mutate();
  };

  const formId = `resolve-${item.id}`;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="File to client"
      description={
        <>
          Filing <span className="font-medium text-foreground">{item.title}</span>. This is recorded in the audit log.
        </>
      }
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={resolve.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!clientId || yearInvalid || resolve.isPending}>
            {resolve.isPending && <Loader2 className="animate-spin" />}
            File document
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="grid gap-5">
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-xs font-medium text-muted-foreground">Client</legend>
          {candidates.map((c) => (
            <label
              key={c.clientId}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/50',
                clientId === c.clientId && 'border-primary bg-accent-soft/50 hover:bg-accent-soft/50',
              )}
            >
              <input
                type="radio"
                name={`${formId}-client`}
                value={c.clientId}
                checked={clientId === c.clientId}
                onChange={() => setClientId(c.clientId)}
                className="size-4 accent-[var(--color-primary)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{c.name}</span>
                <span className="block font-mono text-[11px] text-muted-foreground">{c.clientId}</span>
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">{formatPercent(c.confidence, 0)} match</span>
            </label>
          ))}
        </fieldset>

        <div className="grid gap-1.5">
          <Label htmlFor={`${formId}-year`}>Tax year (optional)</Label>
          <Input
            id={`${formId}-year`}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            placeholder="e.g. 2026"
            value={taxYear}
            onChange={(e) => setTaxYear(e.target.value.replace(/\D/g, ''))}
            className="w-32"
            aria-invalid={yearInvalid}
          />
          {yearInvalid && <p className="text-xs text-danger">Enter a four-digit year.</p>}
        </div>

        {resolve.isError && <InlineError>{resolve.error.message}</InlineError>}
      </form>
    </Dialog>
  );
}
