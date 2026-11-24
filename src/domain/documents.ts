import { createHash, randomBytes } from 'node:crypto';
import { toVectorLiteral, type Embedder } from '../ai/embeddings.js';
import { FIELDS, fieldValue, normalizeAmount, normalizeDate, type DocType, type Extraction } from '../ai/extraction.js';
import { errorCategory } from '../ai/usage.js';
import { firmOf, type Db } from '../db/index.js';
import { maskSensitive } from './audit.js';
import { extractText } from '../documents/text.js';
import type { AppServices } from '../services.js';
import type { MatchResult } from './matching.js';

/** `processing`: a background intake job owns it (not in the inbox yet). */
export type DocumentStatus = 'processing' | 'inbox' | 'filed' | 'review';

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
  /** False until the file's text has been read (batch intake reads it in the background). Never extract before that. */
  textRead: boolean;
  pages: string[];
  receivedAt: string;
  filedAt: string | null;
  uploadedBy: string | null;
  reviewReason: string | null;
  extraction: Extraction | null;
  match: MatchResult | null;
  /** Bumped when the title, client or type changes: passages built from an older version are stale. */
  contentVersion: number;
}

export const SUPPORTED_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'text/plain': 'txt' };
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const TS = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const SELECT = `
  select d.id, d.client_id, c.name as client_name, d.tax_year, d.doc_type, d.title, d.status, d.storage_key,
         d.mime_type, d.source_filename, d.page_count, d.text_layer, d.page_text, ${TS('d.received_at')} as received_at,
         ${TS('d.filed_at')} as filed_at, d.uploaded_by, d.review_reason, d.extraction, d.match, d.content_version
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
  content_version: number;
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
    textRead: r.page_text !== null,
    pages: r.page_text ?? [],
    receivedAt: r.received_at,
    filedAt: r.filed_at,
    uploadedBy: r.uploaded_by,
    reviewReason: r.review_reason,
    extraction: r.extraction,
    match: r.match,
    contentVersion: Number(r.content_version),
  };
}

export async function getDocument(db: Db, id: string): Promise<DocumentRecord | null> {
  const [row] = await db.query<Row>(`${SELECT} where d.id = $1 and d.firm_id = $2`, [id, firmOf(db)]);
  return row ? toRecord(row) : null;
}

export async function listDocumentsByStatus(db: Db, status: DocumentStatus, limit = 50): Promise<DocumentRecord[]> {
  const rows = await db.query<Row>(
    `${SELECT} where d.firm_id = $3 and d.status = $1 order by d.received_at desc, d.id limit $2`,
    [status, limit, firmOf(db)],
  );
  return rows.map(toRecord);
}

const MAX_LINE = 1000;

/** Splits page text into overlapping passages of roughly `size` characters, on line boundaries. */
export function chunkPages(pages: string[], size = 700): { page: number; content: string }[] {
  const chunks: { page: number; content: string }[] = [];
  pages.forEach((text, i) => {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // A file can be one endless line: cut it, so no passage (or regular expression over it) is unbounded.
      .flatMap((l) => (l.length <= MAX_LINE ? [l] : (l.match(new RegExp(`.{1,${MAX_LINE}}`, 'gsu')) ?? [])));
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
  /** An extraction already made for these bytes (the eval, re-ingests): stored, and used for the passage context. */
  extraction?: Extraction;
  /**
   * Batch intake: only store the file and record the document as `processing`, together with the background job that
   * will read, index, extract, match and file it. One statement: there is never a `processing` document without a job.
   */
  intakeJob?: { createdBy: string; batchId: string | null; idempotencyKey: string | null; maxAttempts: number };
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
): Promise<{ id: string; duplicate: boolean; jobId: number | null }> {
  const ext = SUPPORTED_TYPES[input.mimeType];
  if (!ext) throw new Error(`Unsupported file type: ${input.mimeType}`);
  if (input.bytes.byteLength === 0) throw new Error('Empty file');
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('File too large');

  const sha = createHash('sha256').update(input.bytes).digest('hex');
  // Per firm: another firm holding the same file must not show up as a duplicate.
  const firmId = firmOf(db);
  const findExisting = async () => {
    const [row] = await db.query<{ id: string }>(
      'select id from documents where content_sha256 = $1 and firm_id = $2',
      [sha, firmId],
    );
    return row ? { id: row.id, duplicate: true, jobId: null } : null;
  };
  const existing = await findExisting();
  if (existing) return existing;

  const id = input.id ?? `doc_${randomBytes(6).toString('hex')}`;
  const { pages, textLayer } = input.intakeJob
    ? { pages: [] as string[], textLayer: true }
    : await extractText(input.bytes, input.mimeType);
  const storageKey = `documents/${id}/${sha.slice(0, 16)}.${ext}`;
  await services.files.put(storageKey, input.bytes, input.mimeType);

  // SELECT rather than VALUES so a batch upload can add its condition; hence the explicit types.
  const insertDocument = `
    insert into documents (id, client_id, tax_year, doc_type, title, status, storage_key, page_count, received_at,
                           filed_at, filed_by, source_filename, mime_type, content_sha256, uploaded_by, text_layer,
                           page_text, extraction, extracted_at, firm_id)
    select $1::text, $2::text, $3::int, $4::text, $5::text, $6::text, $7::text, $8::int, coalesce($9::timestamptz, now()),
           case when $6::text = 'filed' then coalesce($9::timestamptz, now()) end, $10::text, $11::text, $12::text,
           $13::text, $14::text, $15::boolean, $16::jsonb, $17::jsonb, case when $17::jsonb is not null then now() end,
           $18::text`;
  const params: unknown[] = [
    id,
    input.filed?.clientId ?? null,
    input.filed?.taxYear ?? null,
    input.filed?.docType ?? null,
    input.title ?? titleFromFilename(input.filename),
    input.filed ? 'filed' : input.intakeJob ? 'processing' : 'inbox',
    storageKey,
    input.intakeJob ? null : pages.length,
    input.receivedAt ?? null,
    input.filed?.staffId ?? null,
    input.filename,
    input.mimeType,
    sha,
    input.uploadedBy,
    textLayer,
    input.intakeJob ? null : JSON.stringify(pages),
    input.extraction ? JSON.stringify(input.extraction) : null,
    firmId,
  ];
  try {
    if (input.intakeJob) {
      const job = input.intakeJob;
      // With a batch, taking one of its places is part of the same statement: a full batch stores nothing.
      const [row] = await db.query<{ id: number | string }>(
        `with slot as (
           update batches set accepted = accepted + 1
           where id = $19 and firm_id = $18 and accepted < total returning id
         ), doc as (
           ${insertDocument}
           where $19::text is null or exists (select 1 from slot)
           returning id, firm_id
         )
         insert into jobs (kind, batch_id, document_id, created_by, idempotency_key, max_attempts, firm_id)
         select 'intake', $19::text, doc.id, $20::text, $21::text, $22::int, doc.firm_id from doc returning id`,
        [...params, job.batchId, job.createdBy, job.idempotencyKey, job.maxAttempts],
      );
      if (!row) throw new BatchFullError();
      return { id, duplicate: false, jobId: Number(row.id) };
    }
    await db.query(insertDocument, params);
  } catch (error) {
    // Another request stored the same bytes between the check above and the insert.
    const raced = isUniqueViolation(error) ? await findExisting() : null;
    if (raced) return raced;
    throw error;
  }
  await reindexDocument(db, services.embedder, id);
  return { id, duplicate: false, jobId: null };
}

/** The batch already has all the files it was created for. */
export class BatchFullError extends Error {
  override name = 'BatchFullError';
}

/** Postgres unique_violation, from either driver. */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}

/** Background intake, first step: read the stored file's text layer into the document. Safe to run twice. */
export async function readStoredText(db: Db, files: AppServices['files'], id: string): Promise<{ pages: number }> {
  const doc = await getDocument(db, id);
  if (!doc?.storageKey || !doc.mimeType) throw new Error('Document or stored file missing');
  const bytes = await files.get(doc.storageKey);
  if (!bytes) throw new Error('Stored file not found');
  const { pages, textLayer } = await extractText(bytes, doc.mimeType);
  await db.query(
    'update documents set page_text = $2::jsonb, page_count = $3, text_layer = $4 where id = $1 and firm_id = $5',
    [id, JSON.stringify(pages), pages.length, textLayer, firmOf(db)],
  );
  return { pages: pages.length };
}

/** Bump when `passageContext` changes: start-up then rebuilds older passages (`reindexStale`). */
export const PASSAGE_VERSION = 2;

/** Identifiers that say which document a passage belongs to, repeated on every page (continuation pages lack them). */
const KEY_FIELDS: Record<DocType, { name: string; label: string }[]> = {
  invoice: [{ name: 'invoice_number', label: 'invoice' }],
  bank_statement: [{ name: 'account_last4', label: 'account ****' }],
  engagement_letter: [{ name: 'tax_year', label: 'tax year' }],
  tax_form: [
    { name: 'form_type', label: 'Form' },
    { name: 'tax_year', label: 'tax year' },
  ],
};

// Bounded and anchored after a non-digit, so a long run of digits is scanned once, not once per digit.
const AMOUNTS = /(?<![\d,])\(?-?\$?[ ]?\d{1,3}(?:,?\d{3}){0,4}\.\d{2}(?!\d)\)?/g;
const DATES =
  /\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2} [A-Za-z]{3,9},? \d{4}|[A-Za-z]{3,9} \d{1,2},? \d{4})\b/g;

/** Does this passage print the extracted value? Compared after the same normalisation the extractors use. */
function passageHasValue(kind: string, value: string, text: string): boolean {
  switch (kind) {
    case 'amount':
      return [...text.matchAll(AMOUNTS)].some((m) => normalizeAmount(m[0]) === value);
    case 'date':
      return [...text.matchAll(DATES)].some((m) => normalizeDate(m[0]) === value);
    case 'last4':
      return text.replace(/[^\d*]/g, ' ').includes(value);
    default:
      return text.toLowerCase().includes(value.toLowerCase());
  }
}

/** A field description without its examples: "Form name, e.g. 1099-INT, W-2" would put every form's number on every page. */
function plainDescription(description: string): string {
  return description
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/,?\s*e\.g\..*$/i, '')
    .trim()
    .toLowerCase();
}

/**
 * The context line(s) a passage starts with, so it can be found and cited on its own:
 * - document: title, client, document type and its key identifiers (account ending 9950), on every page;
 * - page: which extracted fields this passage holds, by their plain-English description ("balance at the end of
 *   the period" for the closing balance), so a question in other words still lands on the page with the answer.
 * Without an extraction (seeded or not yet extracted) only the document line is written.
 */
export function passageContext(doc: DocumentRecord, text: string, page: number): string {
  const extraction = doc.extraction && doc.extraction.docType !== 'other' ? doc.extraction : null;
  const parts = [doc.title, doc.clientName ?? 'unfiled'];
  if (extraction) {
    const type = extraction.docType as DocType;
    parts.push(type.replace('_', ' '));
    for (const key of KEY_FIELDS[type]) {
      const value = fieldValue(extraction, key.name);
      if (value && !doc.title.includes(value))
        parts.push(key.label.endsWith('*') ? `${key.label}${value}` : `${key.label} ${value}`);
    }
  }
  parts.push(`page ${page}`);
  const lines = [parts.join(' | ')];
  if (extraction) {
    const held = FIELDS[extraction.docType as DocType].filter((def) => {
      const value = fieldValue(extraction, def.name);
      return value !== null && passageHasValue(def.kind, value, text);
    });
    if (held.length) {
      // Descriptions, not field names: "period end" would tie a statement's first page (which prints the period) with
      // the page holding the balance "at the end of the period".
      lines.push(`On this page: ${held.map((d) => plainDescription(d.description)).join('; ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * (Re)builds a document's search passages. Each passage starts with its context (see `passageContext`), so a page
 * that only holds "Closing balance: $90,677.03" still says which statement, client and account it belongs to, and
 * that it holds the closing balance.
 * Called on ingest and again after filing, when the title, client and extraction become known.
 */
export async function reindexDocument(db: Db, embedder: Embedder, id: string): Promise<void> {
  const doc = await getDocument(db, id);
  if (!doc) return;
  const chunks = chunkPages(doc.pages).map((c) => ({
    ...c,
    content: `${passageContext(doc, c.content, c.page)}\n${c.content}`,
  }));
  const vectors = chunks.length
    ? await embedder.embed(
        chunks.map((c) => c.content),
        'document',
      )
    : [];
  // One statement: passages are replaced in place and leftovers removed, so a crash can't leave the document with none,
  // and two rebuilds at once can't collide. indexed_version records which content these passages were built from.
  await db.query(
    `with fresh as (
       select * from jsonb_to_recordset($3::jsonb) as x(i int, page int, content text, embedding text)
     ), put as (
       insert into document_chunks (id, document_id, page, chunk_index, content, embedding, embedding_model,
                                    passage_version, firm_id)
       select $1 || '_c' || i, $1, page, i, content, embedding::vector, $4, $5, $2 from fresh
       on conflict (id) do update set page = excluded.page, content = excluded.content, embedding = excluded.embedding,
         embedding_model = excluded.embedding_model, passage_version = excluded.passage_version
     ), gone as (
       delete from document_chunks where document_id = $1 and firm_id = $2 and chunk_index >= $6
     )
     update documents set indexed_version = $7 where id = $1 and firm_id = $2`,
    [
      id,
      firmOf(db),
      JSON.stringify(
        chunks.map((c, i) => ({ i, page: c.page, content: c.content, embedding: toVectorLiteral(vectors[i]!) })),
      ),
      embedder.model,
      PASSAGE_VERSION,
      chunks.length,
      doc.contentVersion,
    ],
  );
}

/**
 * Rebuilds passages after filing, when the document is already filed: a failure (the embedding service is down) must not
 * fail the filing. The document stays marked stale and is rebuilt on the next start.
 */
export async function refreshPassages(db: Db, embedder: Embedder, id: string): Promise<boolean> {
  try {
    await reindexDocument(db, embedder, id);
    return true;
  } catch (error) {
    console.error(`Could not rebuild search passages for ${id}: ${errorCategory(error)}`);
    return false;
  }
}

/**
 * Rebuilds the passages of every document that has none yet, has any built by another embedder (local → Voyage) or in an
 * older format, or changed since they were built. One document's failure is logged and doesn't stop the rest. Runs on start-up, so a deploy that changes either needs no manual step. `all` rebuilds every document.
 */
export async function reindexStale(
  db: Db,
  embedder: Embedder,
  options: { all?: boolean; log?: (msg: string) => void } = {},
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `select d.id from documents d
     where d.firm_id = $4 and d.status <> 'processing' and ($1::boolean
        or d.indexed_version is distinct from d.content_version
        or exists (select 1 from document_chunks ch
                   where ch.document_id = d.id and (ch.embedding_model is distinct from $2 or ch.passage_version < $3)))
     order by d.received_at, d.id`,
    [options.all ?? false, embedder.model, PASSAGE_VERSION, firmOf(db)],
  );
  let rebuilt = 0;
  for (const [i, row] of rows.entries()) {
    if (await refreshPassages(db, embedder, row.id)) rebuilt++;
    if ((i + 1) % 25 === 0) options.log?.(`Reindexed ${i + 1} of ${rows.length} documents...`);
  }
  return rebuilt;
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

/** The title a document gets when filed: a file-name title is replaced by a descriptive one. */
export function titleForFiling(doc: DocumentRecord, extraction: Extraction | null): string {
  return (extraction && hasFilenameTitle(doc) && describeDocument(extraction)) || doc.title;
}

/** Saves an extraction, unless the document moved on (was filed, taken by a job) since it was read as `status`. */
export async function saveExtraction(
  db: Db,
  id: string,
  extraction: Extraction,
  status: DocumentStatus,
): Promise<void> {
  await db.query(
    `update documents set extraction = $2::jsonb, extracted_at = now()
     where id = $1 and firm_id = $3 and status = $4`,
    [id, JSON.stringify(extraction), firmOf(db), status],
  );
}

/** Saves a match, on the same condition. */
export async function saveMatch(db: Db, id: string, match: MatchResult, status: DocumentStatus): Promise<void> {
  await db.query('update documents set match = $2::jsonb where id = $1 and firm_id = $3 and status = $4', [
    id,
    JSON.stringify(match),
    firmOf(db),
    status,
  ]);
}

/** What the batch progress list shows of each document: no page text, so polling it stays cheap. */
export async function documentSummaries(
  db: Db,
  ids: string[],
): Promise<
  Map<string, { title: string; filename: string | null; clientName: string | null; reviewReason: string | null }>
> {
  const rows = await db.query<{
    id: string;
    title: string;
    source_filename: string | null;
    client_name: string | null;
    review_reason: string | null;
  }>(
    `select d.id, d.title, d.source_filename, c.name as client_name, d.review_reason
     from documents d left join clients c on c.id = d.client_id and c.firm_id = d.firm_id
     where d.firm_id = $1 and d.id = any($2::text[])`,
    [firmOf(db), ids],
  );
  return new Map(
    rows.map((r) => [
      r.id,
      { title: r.title, filename: r.source_filename, clientName: r.client_name, reviewReason: r.review_reason },
    ]),
  );
}

/**
 * Files a document for a person (through Claude or the review queue), with its title and, when given, the CRM note and
 * the audit row in one statement. Callers have already checked access and the match. Passages are rebuilt afterwards
 * (`refreshPassages`). Background jobs file through `completeFiling` (src/jobs/queue.ts).
 */
export async function markFiled(
  db: Db,
  input: {
    id: string;
    clientId: string;
    taxYear: number | null;
    docType: string | null;
    staffId: string;
    title: string;
    note?: string;
    audit?: { tool: string; input: unknown; detail: string };
  },
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `with d as (
       update documents
       set client_id = $2, tax_year = $3, doc_type = $4, status = 'filed', filed_at = now(), filed_by = $5, title = $7,
           review_reason = null, content_version = content_version + 1
       where id = $1 and firm_id = $6 and status in ('inbox', 'review') returning id
     ), n as (
       insert into notes (id, client_id, author_id, body, kind, firm_id)
       select $8, $2, $5, $9, 'filing', $6 from d where $9::text is not null
     ), a as (
       insert into audit_log (firm_id, staff_id, tool, input, outcome, detail, duration_ms)
       select $6, $5, $10, $11::jsonb, 'ok', $12, 0 from d where $10::text is not null
     )
     select id from d`,
    [
      input.id,
      input.clientId,
      input.taxYear,
      input.docType,
      input.staffId,
      firmOf(db),
      input.title,
      `nt_${randomBytes(5).toString('hex')}`,
      input.note ?? null,
      input.audit?.tool ?? null,
      input.audit ? JSON.stringify(maskSensitive(input.audit.input) ?? null) : null,
      input.audit?.detail ?? null,
    ],
  );
  return rows.length === 1;
}

export async function markForReview(db: Db, input: { id: string; reason: string; staffId: string }): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `update documents set status = 'review', review_reason = $2, sent_to_review_by = $3, sent_to_review_at = now()
     where id = $1 and firm_id = $4 and status = 'inbox' returning id`,
    [input.id, input.reason, input.staffId, firmOf(db)],
  );
  return rows.length === 1;
}

export async function documentCounts(db: Db): Promise<Record<DocumentStatus, number>> {
  const rows = await db.query<{ status: DocumentStatus; n: number }>(
    'select status, count(*)::int as n from documents where firm_id = $1 group by status',
    [firmOf(db)],
  );
  const counts: Record<DocumentStatus, number> = { processing: 0, inbox: 0, review: 0, filed: 0 };
  for (const r of rows) counts[r.status] = Number(r.n);
  return counts;
}
