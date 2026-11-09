import type { Extraction } from '../ai/extraction.js';
import type { Db } from '../db/index.js';
import type { AppServices } from '../services.js';
import { saveExtraction, saveMatch, type DocumentRecord } from './documents.js';
import { loadMatchProfiles, matchClients, type MatchResult } from './matching.js';

/** Extracts a document once and caches the result (extraction costs money with Claude). */
export async function ensureExtraction(
  db: Db,
  services: Pick<AppServices, 'extractor' | 'files'>,
  doc: DocumentRecord,
  refresh = false,
): Promise<Extraction> {
  if (doc.extraction && !refresh) return doc.extraction;
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
  await saveExtraction(db, doc.id, extraction);
  return extraction;
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
  await saveMatch(db, doc.id, match);
  return match;
}

/**
 * The match to use for an access decision on an unfiled document, computing it if nobody has yet, so viewing
 * a file follows the same rule as extract_document (no "not matched yet, so anyone may look" gap).
 */
export async function ensureMatch(
  db: Db,
  services: Pick<AppServices, 'extractor' | 'files' | 'filing'>,
  doc: DocumentRecord,
): Promise<MatchResult | null> {
  if (doc.status === 'filed') return doc.match;
  if (doc.match) return doc.match;
  return computeMatch(db, services, doc, await ensureExtraction(db, services, doc));
}
