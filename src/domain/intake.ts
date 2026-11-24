import type { Extraction } from '../ai/extraction.js';
import { firmOf, type Db } from '../db/index.js';
import type { AppServices } from '../services.js';
import { getDocument, readStoredText, saveExtraction, saveMatch, type DocumentRecord } from './documents.js';
import type { Actor } from './types.js';
import { loadMatchProfiles, matchClients, type MatchResult } from './matching.js';

/**
 * The document with its text read. Batch intake reads text in the background; if its job died before that, the document is
 * in the inbox unread, and the first person (or Claude) to open it reads it here. Nothing may be extracted, matched or
 * shown on the strength of text nobody has read: that is how a document's owner would go unnoticed.
 */
export async function ensureText(
  db: Db,
  services: Pick<AppServices, 'files'>,
  doc: DocumentRecord,
): Promise<DocumentRecord> {
  if (doc.textRead) return doc;
  if (doc.status === 'processing') throw new Error('The document is still being processed');
  await readStoredText(db, services.files, doc.id);
  const read = await getDocument(db, doc.id);
  if (!read?.textRead) throw new Error('The document could not be read');
  return read;
}

// One extraction per document at a time (per extractor): ten people opening the same new document make one model call.
const inFlight = new WeakMap<object, Map<string, Promise<Extraction>>>();

/** Extracts a document once and caches the result (extraction costs money with a model). */
export async function ensureExtraction(
  db: Db,
  services: Pick<AppServices, 'extractor' | 'files'>,
  doc: DocumentRecord,
  refresh = false,
): Promise<Extraction> {
  if (doc.extraction && !refresh) return doc.extraction;
  if (!doc.textRead) throw new Error('The document has not been read yet');
  const running = inFlight.get(services.extractor) ?? new Map<string, Promise<Extraction>>();
  inFlight.set(services.extractor, running);
  const key = `${firmOf(db)}:${doc.id}`;
  const current = running.get(key);
  if (current) return current;
  const work = (async () => {
    const pdf =
      !doc.textLayer && doc.storageKey && doc.mimeType === 'application/pdf'
        ? await services.files.get(doc.storageKey)
        : null;
    const extraction = await services.extractor.extract({
      filename: doc.sourceFilename,
      pages: doc.pages,
      textLayer: doc.textLayer,
      pdf,
    });
    await saveExtraction(db, doc.id, extraction, doc.status);
    return extraction;
  })().finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

/**
 * Scores the document against every active client. Always recomputed (it's cheap and the client list can change),
 * and always across all clients: access filtering happens when results are shown, never before matching,
 * so a document can't be filed to a look-alike just because the real owner is hidden from the caller.
 */
export async function computeMatch(
  db: Db,
  services: Pick<AppServices, 'filing'>,
  doc: DocumentRecord,
  extraction: Extraction,
): Promise<MatchResult> {
  const match = matchClients(extraction, doc.pages.join('\n'), await loadMatchProfiles(db), services.filing);
  await saveMatch(db, doc.id, match, doc.status);
  return match;
}

/**
 * The match to use for an access decision on an unfiled document, computing it if nobody has yet, so viewing a file follows
 * the same rule as extract_document (no "not matched yet, so anyone may look" gap). Partners see every client of their
 * firm, so the answer can't depend on it: nothing is computed, and no model call made, for them or the demo visitor.
 */
export async function ensureMatch(
  db: Db,
  services: Pick<AppServices, 'extractor' | 'files' | 'filing'>,
  doc: DocumentRecord,
  actor: Pick<Actor, 'role'>,
): Promise<MatchResult | null> {
  if (doc.status === 'filed' || doc.status === 'processing' || actor.role === 'partner') return doc.match;
  if (doc.match) return doc.match;
  const read = await ensureText(db, services, doc);
  return computeMatch(db, services, read, await ensureExtraction(db, services, read));
}
