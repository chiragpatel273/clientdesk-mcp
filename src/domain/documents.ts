import { createHash, randomBytes } from 'node:crypto';
import { toVectorLiteral, type Embedder } from '../ai/embeddings.js';
import { fieldValue, type DocType, type Extraction } from '../ai/extraction.js';
import type { Db } from '../db/index.js';
import { extractText } from '../documents/text.js';
import type { AppServices } from '../services.js';
import type { MatchResult } from './matching.js';

export type DocumentStatus = 'inbox' | 'filed' | 'review';

export interface DocumentRecord {
  id: string;
  clientId: string | null;
  clientName: string | null;
  taxYear: number | null;
  docType: string | null;
  title: string;
  status: DocumentStatus;
  storageKey: string | null;
  mimeType: string | null;
  sourceFilename: string | null;
  pageCount: number | null;
  textLayer: boolean;
  pages: string[];
  receivedAt: string;
  filedAt: string | null;
  uploadedBy: string | null;
  reviewReason: string | null;
  extraction: Extraction | null;
  match: MatchResult | null;
}

export const SUPPORTED_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'text/plain': 'txt' };
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const TS = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const SELECT = `
  select d.id, d.client_id, c.name as client_name, d.tax_year, d.doc_type, d.title, d.status, d.storage_key,
         d.mime_type, d.source_filename, d.page_count, d.text_layer, d.page_text, ${TS('d.received_at')} as received_at,
         ${TS('d.filed_at')} as filed_at, d.uploaded_by, d.review_reason, d.extraction, d.match
  from documents d left join clients c on c.id = d.client_id`;

type Row = {
  id: string;
  client_id: string | null;
  client_name: string | null;
  tax_year: number | null;
  doc_type: string | null;
  title: string;
  status: DocumentStatus;
  storage_key: string | null;
  mime_type: string | null;
  source_filename: string | null;
  page_count: number | null;
  text_layer: boolean;
  page_text: string[] | null;
  received_at: string;
  filed_at: string | null;
  uploaded_by: string | null;
  review_reason: string | null;
  extraction: Extraction | null;
  match: MatchResult | null;
};

function toRecord(r: Row): DocumentRecord {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    taxYear: r.tax_year === null ? null : Number(r.tax_year),
    docType: r.doc_type,
    title: r.title,
    status: r.status,
    storageKey: r.storage_key,
    mimeType: r.mime_type,
    sourceFilename: r.source_filename,
    pageCount: r.page_count === null ? null : Number(r.page_count),
    textLayer: r.text_layer,
    pages: r.page_text ?? [],
    receivedAt: r.received_at,
    filedAt: r.filed_at,
    uploadedBy: r.uploaded_by,
    reviewReason: r.review_reason,
    extraction: r.extraction,
    match: r.match,
  };
}

export async function getDocument(db: Db, id: string): Promise<DocumentRecord | null> {
  const [row] = await db.query<Row>(`${SELECT} where d.id = $1`, [id]);
  return row ? toRecord(row) : null;
}

export async function listDocumentsByStatus(db: Db, status: DocumentStatus, limit = 50): Promise<DocumentRecord[]> {
  const rows = await db.query<Row>(`${SELECT} where d.status = $1 order by d.received_at desc, d.id limit $2`, [
    status,
    limit,
  ]);
  return rows.map(toRecord);
}

/** Splits page text into overlapping passages of roughly `size` characters, on line boundaries. */
export function chunkPages(pages: string[], size = 700): { page: number; content: string }[] {
  const chunks: { page: number; content: string }[] = [];
  pages.forEach((text, i) => {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let current: string[] = [];
    let length = 0;
    for (const line of lines) {
      if (length + line.length > size && current.length > 0) {
        chunks.push({ page: i + 1, content: current.join('\n') });
        current = current.slice(-1); // one line of overlap keeps a label with its value
        length = current[0]?.length ?? 0;
      }
      current.push(line);
      length += line.length + 1;
    }
    if (current.length > 0) chunks.push({ page: i + 1, content: current.join('\n') });
  });
  return chunks;
}

export interface IngestInput {
  bytes: Uint8Array;
  mimeType: string;
  filename: string | null;
  title?: string;
  uploadedBy: string | null;
  /** Demo seeding and the dashboard's review resolution can create already-filed documents. */
  filed?: { clientId: string; taxYear: number | null; docType: DocType | 'other'; staffId: string | null };
  id?: string;
  receivedAt?: string;
}

function titleFromFilename(filename: string | null): string {
  if (!filename) return 'Untitled document';
  return (
    filename
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled document'
  );
}

/**
 * Stores a file, reads its text, chunks and embeds it, and records it in the inbox (or filed, for seeding).
 * The same bytes uploaded twice return the existing document.
 */
export async function ingestDocument(
  db: Db,
  services: Pick<AppServices, 'files' | 'embedder'>,
  input: IngestInput,
): Promise<{ id: string; duplicate: boolean }> {
  const ext = SUPPORTED_TYPES[input.mimeType];
  if (!ext) throw new Error(`Unsupported file type: ${input.mimeType}`);
  if (input.bytes.byteLength === 0) throw new Error('Empty file');
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('File too large');

  const sha = createHash('sha256').update(input.bytes).digest('hex');
  const [existing] = await db.query<{ id: string }>('select id from documents where content_sha256 = $1', [sha]);
  if (existing) return { id: existing.id, duplicate: true };

  const id = input.id ?? `doc_${randomBytes(6).toString('hex')}`;
  const { pages, textLayer } = await extractText(input.bytes, input.mimeType);
  const storageKey = `documents/${id}/${sha.slice(0, 16)}.${ext}`;
  await services.files.put(storageKey, input.bytes, input.mimeType);

  await db.query(
    `insert into documents (id, client_id, tax_year, doc_type, title, status, storage_key, page_count, received_at,
                            filed_at, filed_by, source_filename, mime_type, content_sha256, uploaded_by, text_layer, page_text)
     values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()),
             case when $6 = 'filed' then coalesce($9::timestamptz, now()) end, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
    [
      id,
      input.filed?.clientId ?? null,
      input.filed?.taxYear ?? null,
      input.filed?.docType ?? null,
      input.title ?? titleFromFilename(input.filename),
      input.filed ? 'filed' : 'inbox',
      storageKey,
      pages.length,
      input.receivedAt ?? null,
      input.filed?.staffId ?? null,
      input.filename,
      input.mimeType,
      sha,
      input.uploadedBy,
      textLayer,
      JSON.stringify(pages),
    ],
  );
  await reindexDocument(db, services.embedder, id);
  return { id, duplicate: false };
}

/**
 * (Re)builds a document's search passages. Each passage starts with a context line (title, client, page), so a
 * page that only holds "Total due: $4,768.20" still says which invoice and client it belongs to.
 * Called on ingest and again after filing, when the title and client become known.
 */
export async function reindexDocument(db: Db, embedder: Embedder, id: string): Promise<void> {
  const doc = await getDocument(db, id);
  if (!doc) return;
  const chunks = chunkPages(doc.pages).map((c) => ({
    ...c,
    content: `${doc.title} | ${doc.clientName ?? 'unfiled'} | page ${c.page}\n${c.content}`,
  }));
  const vectors = chunks.length ? await embedder.embed(chunks.map((c) => c.content), 'document') : [];
  await db.query('delete from document_chunks where document_id = $1', [id]);
  for (const [i, chunk] of chunks.entries()) {
    await db.query(
      `insert into document_chunks (id, document_id, page, chunk_index, content, embedding, embedding_model)
       values ($1, $2, $3, $4, $5, $6::vector, $7)`,
      [`${id}_c${i}`, id, chunk.page, i, chunk.content, toVectorLiteral(vectors[i]!), embedder.model],
    );
  }
}

/** A descriptive title from the extracted fields, e.g. "Invoice INV-20931 from Northwind Office Supplies". */
export function describeDocument(extraction: Extraction): string | null {
  const v = (name: string) => fieldValue(extraction, name);
  switch (extraction.docType) {
    case 'invoice':
      return v('invoice_number') && v('vendor_name') ? `Invoice ${v('invoice_number')} from ${v('vendor_name')}` : null;
    case 'bank_statement':
      return v('bank_name') && v('period_end')
        ? `${v('bank_name')} statement ${v('period_start') ?? ''} to ${v('period_end')}`.replace('  ', ' ')
        : null;
    case 'engagement_letter':
      return v('tax_year') ? `Engagement letter ${v('tax_year')}${v('signed_date') ? '' : ' (unsigned)'}` : null;
    case 'tax_form':
      return v('form_type') && v('tax_year')
        ? `Form ${v('form_type')} ${v('tax_year')}${v('payer_name') ? ` from ${v('payer_name')}` : ''}`
        : null;
    default:
      return null;
  }
}

/** Was this title generated from the upload's file name (so a better one may replace it)? */
export function hasFilenameTitle(doc: DocumentRecord): boolean {
  return doc.title === titleFromFilename(doc.sourceFilename);
}

/** After filing: give a file-name-titled document a descriptive title, then rebuild its passages. */
export async function retitleAndReindex(db: Db, embedder: Embedder, id: string, extraction: Extraction | null): Promise<void> {
  const doc = await getDocument(db, id);
  if (!doc) return;
  const title = extraction ? describeDocument(extraction) : null;
  if (title && hasFilenameTitle(doc)) await db.query('update documents set title = $2 where id = $1', [id, title]);
  await reindexDocument(db, embedder, id);
}

export async function saveExtraction(db: Db, id: string, extraction: Extraction): Promise<void> {
  await db.query('update documents set extraction = $2::jsonb, extracted_at = now() where id = $1', [
    id,
    JSON.stringify(extraction),
  ]);
}

export async function saveMatch(db: Db, id: string, match: MatchResult): Promise<void> {
  await db.query('update documents set match = $2::jsonb where id = $1', [id, JSON.stringify(match)]);
}

/** Files a document. Callers have already checked access and the match; this only records the result. */
export async function markFiled(
  db: Db,
  input: { id: string; clientId: string; taxYear: number | null; docType: string | null; staffId: string },
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `update documents
     set client_id = $2, tax_year = $3, doc_type = $4, status = 'filed', filed_at = now(), filed_by = $5, review_reason = null
     where id = $1 and status in ('inbox', 'review') returning id`,
    [input.id, input.clientId, input.taxYear, input.docType, input.staffId],
  );
  return rows.length === 1;
}

export async function markForReview(db: Db, input: { id: string; reason: string; staffId: string }): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `update documents set status = 'review', review_reason = $2, sent_to_review_by = $3, sent_to_review_at = now()
     where id = $1 and status = 'inbox' returning id`,
    [input.id, input.reason, input.staffId],
  );
  return rows.length === 1;
}

export async function documentCounts(db: Db): Promise<Record<DocumentStatus, number>> {
  const rows = await db.query<{ status: DocumentStatus; n: number }>(
    'select status, count(*)::int as n from documents group by status',
  );
  const counts: Record<DocumentStatus, number> = { inbox: 0, review: 0, filed: 0 };
  for (const r of rows) counts[r.status] = Number(r.n);
  return counts;
}
