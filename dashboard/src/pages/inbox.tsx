import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { CircleCheck, CircleX, Copy, ExternalLink, FileText, Inbox, Loader2, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { api, openDocument, type InboxItem } from '../api';
import { PageHeader } from '../components/page-header';
import { EmptyState, ErrorState } from '../components/states';
import { Button } from '../components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatDateTime, formatInt, formatRelative } from '../lib/format';
import { cn } from '../lib/utils';

type UploadStatus =
  { state: 'uploading' } | { state: 'done'; title: string; duplicate: boolean } | { state: 'error'; message: string };

interface UploadEntry {
  key: string;
  name: string;
  status: UploadStatus;
}

function contentTypeFor(file: File): 'application/pdf' | 'text/plain' | null {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'application/pdf';
  if (file.type === 'text/plain' || name.endsWith('.txt')) return 'text/plain';
  return null;
}

export function InboxPage() {
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: api.inbox, refetchInterval: 30_000 });

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Documents waiting to be processed. Upload here, then ask Claude to file them."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <UploadCard />
        <Card className="overflow-hidden lg:order-1">
          <CardHeader>
            <CardTitle>Unprocessed documents</CardTitle>
            <CardDescription>
              {inbox.data
                ? `${formatInt(inbox.data.items.length)} waiting`
                : 'Uploaded documents that have not been filed or sent to review.'}
            </CardDescription>
          </CardHeader>
          <InboxList query={inbox} />
        </Card>
      </div>
    </>
  );
}

function InboxList({ query }: { query: UseQueryResult<{ items: InboxItem[] }, Error> }) {
  const [openError, setOpenError] = useState<string | null>(null);

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3 px-5 pb-5">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data.items.length === 0) {
    return (
      <EmptyState icon={Inbox} title="The inbox is empty">
        Upload a PDF or text file to try the intake flow.
      </EmptyState>
    );
  }

  const view = async (id: string) => {
    setOpenError(null);
    try {
      await openDocument(id);
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : 'Could not open the document.');
    }
  };

  return (
    <>
      {openError && <p className="px-5 pb-2 text-sm text-danger">{openError}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Document</TableHead>
            <TableHead className="hidden sm:table-cell">Uploaded by</TableHead>
            <TableHead>Received</TableHead>
            <TableHead className="hidden text-right md:table-cell">Pages</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {query.data.items.map((d) => (
            <TableRow key={d.id} className="hover:bg-muted/40">
              <TableCell className="max-w-0 min-w-40">
                <div className="flex items-center gap-2.5">
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{d.title}</p>
                    {d.filename && <p className="truncate font-mono text-xs text-muted-foreground">{d.filename}</p>}
                  </div>
                </div>
              </TableCell>
              <TableCell className="hidden whitespace-nowrap sm:table-cell">{d.uploadedBy?.name ?? '–'}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                <time dateTime={d.receivedAt} title={formatDateTime(d.receivedAt)}>
                  {formatRelative(d.receivedAt)}
                </time>
              </TableCell>
              <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
                {d.pageCount ?? '–'}
              </TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" onClick={() => void view(d.id)} aria-label={`View ${d.title}`}>
                  <ExternalLink />
                  <span className="hidden sm:inline">View</span>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function UploadCard() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const busy = uploads.some((u) => u.status.state === 'uploading');

  const update = (key: string, status: UploadStatus) =>
    setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, status } : u)));

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const entries = list.map((file, i) => ({
      file,
      entry: { key: `${Date.now()}-${i}-${file.name}`, name: file.name, status: { state: 'uploading' } } as UploadEntry,
    }));
    setUploads((prev) => [...entries.map((e) => e.entry), ...prev].slice(0, 10));

    // One at a time keeps the order predictable and the server load small.
    for (const { file, entry } of entries) {
      const type = contentTypeFor(file);
      if (!type) {
        update(entry.key, { state: 'error', message: 'Only PDF and .txt files can be uploaded.' });
        continue;
      }
      if (file.size === 0) {
        update(entry.key, { state: 'error', message: 'The file is empty.' });
        continue;
      }
      try {
        const res = await api.upload(file, type);
        update(entry.key, { state: 'done', title: res.title, duplicate: res.duplicate });
      } catch (e) {
        update(entry.key, { state: 'error', message: e instanceof Error ? e.message : 'Upload failed.' });
      }
    }
    void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    void queryClient.invalidateQueries({ queryKey: ['stats'] });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void handleFiles(e.dataTransfer.files);
  };

  return (
    <Card className="lg:order-2">
      <CardHeader>
        <CardTitle>Upload</CardTitle>
        <CardDescription>PDF or plain text. Use the fictional demo documents only.</CardDescription>
      </CardHeader>
      <div className="px-5 pb-5">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors',
            dragging ? 'border-primary bg-accent-soft/50' : 'border-border',
          )}
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Upload className="size-5" />
          </div>
          <p className="text-sm font-medium">Drop files here</p>
          <p className="text-xs text-muted-foreground">or</p>
          <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            Choose files
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.txt,application/pdf,text/plain"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              if (e.target.files) void handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {uploads.length > 0 && (
          <ul className="mt-4 grid gap-2" aria-live="polite">
            {uploads.map((u) => (
              <li key={u.key} className="flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm">
                <UploadIcon status={u.status} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{u.status.state === 'done' ? u.status.title : u.name}</p>
                  <p className={cn('text-xs text-muted-foreground', u.status.state === 'error' && 'text-danger')}>
                    {u.status.state === 'uploading'
                      ? 'Uploading…'
                      : u.status.state === 'error'
                        ? u.status.message
                        : u.status.duplicate
                          ? 'Already in ClientDesk: this file was uploaded before.'
                          : 'Added to the inbox.'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function UploadIcon({ status }: { status: UploadStatus }) {
  if (status.state === 'uploading')
    return <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />;
  if (status.state === 'error') return <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failed" />;
  if (status.duplicate) return <Copy className="mt-0.5 size-4 shrink-0 text-warn" aria-label="Duplicate" />;
  return <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-label="Uploaded" />;
}
