import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  FileStack,
  FolderInput,
  Loader2,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { api, type JobItem, type JobStep } from '../api';
import { contentTypeFor } from '../lib/files';
import { formatRelative } from '../lib/format';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

const MAX_FILES = 25;

/** The pipeline, in order. A job's `step` is the last one completed. */
const PIPELINE: { step: JobStep; label: string }[] = [
  { step: 'stored', label: 'Stored' },
  { step: 'text_extracted', label: 'Text read' },
  { step: 'embedded', label: 'Indexed' },
  { step: 'fields_extracted', label: 'Fields extracted' },
  { step: 'matched', label: 'Matched' },
];

function progress(item: JobItem): number {
  if (item.status === 'done' || item.step === 'filed') return PIPELINE.length;
  return PIPELINE.findIndex((p) => p.step === item.step) + 1;
}

function statusText(item: JobItem): string {
  if (item.status === 'done') {
    if (item.outcome?.kind === 'filed') return `Filed to ${item.outcome.clientName}`;
    return `Sent to review${item.outcome?.kind === 'review' && item.outcome.reason ? `: ${item.outcome.reason}` : ''}`;
  }
  if (item.step === 'filed' && item.outcome?.kind === 'filed') {
    const filed = `Filed to ${item.outcome.clientName}`;
    return item.status === 'dead'
      ? `${filed}, but its search entries could not be updated: ${item.lastError ?? 'unknown error'}`
      : `${filed}; updating search…`;
  }
  if (item.status === 'dead')
    return `Failed ${item.attempts} times, back in the inbox: ${item.lastError ?? 'unknown error'}`;
  const next = PIPELINE[progress(item)]?.label ?? 'Filing';
  if (item.attempts > 0 && item.lastError) {
    return `Retrying ${next.toLowerCase()} (attempt ${item.attempts + 1} of ${item.maxAttempts}): ${item.lastError}`;
  }
  return item.status === 'running' ? `${next}…` : `Waiting: ${next.toLowerCase()}`;
}

function JobRow({ item }: { item: JobItem }) {
  const done = progress(item);
  const failed = item.status === 'dead';
  const retrying = item.status !== 'done' && !failed && item.lastError !== null;
  return (
    <li className="rounded-lg border px-3 py-2 text-sm" data-testid="batch-item" data-status={item.status}>
      <div className="flex items-start gap-2.5">
        {item.status === 'done' ? (
          item.outcome?.kind === 'filed' ? (
            <FolderInput className="mt-0.5 size-4 shrink-0 text-ok" aria-label="Filed" />
          ) : (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-label="Sent to review" />
          )
        ) : failed ? (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failed" />
        ) : item.status === 'running' ? (
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Running" />
        ) : (
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Queued" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{item.filename ?? item.title}</p>
          <p className={cn('text-xs text-muted-foreground', (failed || retrying) && 'text-danger')}>
            {statusText(item)}
          </p>
          <div className="mt-1.5 flex gap-1" aria-label={`${done} of ${PIPELINE.length} steps done`}>
            {PIPELINE.map((p, i) => (
              <span
                key={p.step}
                title={p.label}
                className={cn('h-1 flex-1 rounded-full', i < done ? (failed ? 'bg-danger' : 'bg-primary') : 'bg-muted')}
              />
            ))}
          </div>
        </div>
      </div>
    </li>
  );
}

/** A picked file with no background job: the server already had it, or refused it. */
interface JoblessFile {
  key: string;
  name: string;
  kind: 'duplicate' | 'failed';
  message: string;
}

function JoblessRow({ file }: { file: JoblessFile }) {
  const failed = file.kind === 'failed';
  return (
    <li
      className="flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm"
      data-testid="batch-item"
      data-status={file.kind}
    >
      {failed ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Not uploaded" />
      ) : (
        <Copy className="mt-0.5 size-4 shrink-0 text-warn" aria-label="Duplicate" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{file.name}</p>
        <p className={cn('text-xs text-muted-foreground', failed && 'text-danger')}>{file.message}</p>
      </div>
    </li>
  );
}

/**
 * Partners: pick up to 25 files; each is stored and handed to the background job queue, which reads, indexes,
 * extracts, matches and files it (or sends it to review) step by step. Progress is polled until every job settles.
 */
export function BatchIntakeCard() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);
  // Files that never became a job (already uploaded before, or refused): the server's job list can't show them.
  const [jobless, setJobless] = useState<JoblessFile[]>([]);

  const start = useMutation({
    mutationFn: async (files: File[]) => {
      const accepted = files.filter((f) => contentTypeFor(f) && f.size > 0).slice(0, MAX_FILES);
      setRejected(files.filter((f) => !accepted.includes(f)).map((f) => f.name));
      if (accepted.length === 0) throw new Error('Choose PDF or .txt files.');
      const { id } = await api.createBatch(accepted.length);
      setBatchId(id);
      setJobless([]);
      for (const [i, file] of accepted.entries()) {
        const skip = (kind: JoblessFile['kind'], message: string) =>
          setJobless((prev) => [...prev, { key: `${id}-${i}`, name: file.name, kind, message }]);
        try {
          // A retried request with the same key is answered with the first result, never processed twice.
          const result = await api.uploadToBatch(id, file, contentTypeFor(file)!, `${id}-${i}`);
          if (result.duplicate) skip('duplicate', 'Already in ClientDesk: this file was uploaded before.');
        } catch (e) {
          // One refused file must not stop the rest of the batch.
          skip('failed', e instanceof Error ? e.message : 'Upload failed.');
        }
        void queryClient.invalidateQueries({ queryKey: ['batch', id] });
      }
      return id;
    },
  });

  const batch = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => api.batch(batchId!),
    enabled: batchId !== null,
    refetchInterval: (query) => {
      // Settled once every file is accounted for: each is a finished job, or never became one.
      const data = query.state.data;
      const settled =
        data !== undefined &&
        data.items.length + jobless.length >= data.total &&
        data.items.every((i) => i.status === 'done' || i.status === 'dead');
      if (settled && !start.isPending) {
        void queryClient.invalidateQueries({ queryKey: ['inbox'] });
        void queryClient.invalidateQueries({ queryKey: ['stats'] });
        void queryClient.invalidateQueries({ queryKey: ['dead-jobs'] });
        return false;
      }
      return 1000;
    },
  });

  const items = batch.data?.items ?? [];
  const notUploaded = jobless.filter((f) => f.kind === 'failed').length;
  const duplicates = jobless.length - notUploaded;
  // A duplicate needs no work, so it counts as dealt with; a refused file doesn't.
  const finished = items.filter((i) => i.status === 'done').length + duplicates;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileStack className="size-4 text-muted-foreground" /> Batch intake
        </CardTitle>
        <CardDescription>
          Partners: up to {MAX_FILES} files, processed in the background. Clear matches are filed; anything else goes to
          the review queue.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={start.isPending}>
          {start.isPending ? <Loader2 className="animate-spin" /> : <Upload />} Choose files for a batch
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.txt,application/pdf,text/plain"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          data-testid="batch-input"
          onChange={(e) => {
            if (e.target.files?.length) start.mutate(Array.from(e.target.files));
            e.target.value = '';
          }}
        />
        {start.isError && <p className="text-sm text-danger">{start.error.message}</p>}
        {rejected.length > 0 && (
          <p className="text-xs text-muted-foreground">Skipped (not PDF or .txt, or empty): {rejected.join(', ')}</p>
        )}
        {batch.data && (
          <>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {finished} of {batch.data.total} processed
              {notUploaded > 0 && ` · ${notUploaded} not uploaded`}
              {finished === batch.data.total && <CircleCheck className="ml-1 inline size-3.5 text-ok" aria-hidden />}
            </p>
            <ul className="grid gap-2">
              {items.map((item) => (
                <JobRow key={item.jobId} item={item} />
              ))}
              {jobless.map((f) => (
                <JoblessRow key={f.key} file={f} />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Jobs that used up their retries. Their documents are back in the inbox; a partner can run the pipeline again. */
export function DeadLetterCard() {
  const queryClient = useQueryClient();
  const dead = useQuery({ queryKey: ['dead-jobs'], queryFn: api.deadJobs, refetchInterval: 30_000 });
  const retry = useMutation({
    mutationFn: api.retryJob,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['dead-jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
  if (!dead.data || dead.data.items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleAlert className="size-4 text-danger" /> Failed intake jobs
        </CardTitle>
        <CardDescription>
          These stopped after their retries; unfiled documents are back in the inbox. Retry once the cause is fixed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {retry.isError && <p className="mb-2 text-sm text-danger">{retry.error.message}</p>}
        <ul className="grid gap-2">
          {dead.data.items.map((item) => (
            <li key={item.jobId} className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{item.filename ?? item.title}</p>
                <p className="text-xs text-muted-foreground">
                  {item.lastError} · {item.attempts} attempts · {formatRelative(item.updatedAt)}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => retry.mutate(item.jobId)} disabled={retry.isPending}>
                <RotateCcw /> Retry
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
