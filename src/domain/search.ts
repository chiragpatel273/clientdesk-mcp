import { tokenize, toVectorLiteral, type Embedder } from '../ai/embeddings.js';
import { firmOf, type Db } from '../db/index.js';

export interface SearchOptions {
  /** From `accessibleClientIds`: the search never sees documents outside this list. */
  allowedClientIds: string[] | 'all';
  clientId?: string;
  taxYear?: number;
  docType?: string;
  limit: number;
}

export interface Passage {
  chunkId: string;
  documentId: string;
  title: string;
  clientId: string;
  clientName: string;
  taxYear: number | null;
  docType: string | null;
  page: number | null;
  content: string;
  /** Reciprocal-rank-fusion score; only meaningful for ordering. */
  score: number;
  matchedBy: ('semantic' | 'keyword')[];
}

const CANDIDATES = 20;

/**
 * Reference-like tokens in a query: invoice numbers (INV-20931), account digits (4393), amounts. Years are left out
 * (too common to identify anything). Lowercase letters, digits and hyphens only, so they're safe to compare.
 */
export function identifiers(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z]{0,6}-?\d[a-z0-9-]*/g) ?? [];
  return [...new Set(tokens.map((t) => t.replace(/-+$/, '')))]
    .filter((t) => /\d{3,}/.test(t) && !/^(19|20)\d{2}$/.test(t))
    .slice(0, 5);
}
const RRF_K = 60;

// Shared filter: the caller's firm, filed documents only, inside the caller's access list, plus optional filters.
const FILTER = `d.firm_id = $1 and ch.firm_id = $1 and d.status = 'filed'
  and ($2::text[] is null or d.client_id = any($2::text[]))
  and ($3::text is null or d.client_id = $3)
  and ($4::int is null or d.tax_year = $4)
  and ($5::text is null or d.doc_type = $5)`;

/**
 * Hybrid search: pgvector similarity and Postgres full-text, merged with reciprocal-rank fusion.
 * Keyword search catches exact terms (invoice numbers, names); vectors catch paraphrases.
 */
export async function searchDocuments(
  db: Db,
  embedder: Embedder,
  query: string,
  options: SearchOptions,
): Promise<Passage[]> {
  if (options.allowedClientIds !== 'all' && options.allowedClientIds.length === 0) return [];
  const filters = [
    firmOf(db),
    options.allowedClientIds === 'all' ? null : options.allowedClientIds,
    options.clientId ?? null,
    options.taxYear ?? null,
    options.docType ?? null,
  ];

  const [vector] = await embedder.embed([query], 'query');
  const semantic = await db.query<{ id: string }>(
    `select ch.id from document_chunks ch join documents d on d.id = ch.document_id
     where ${FILTER} and ch.embedding_model = $7
     order by ch.embedding <=> $6::vector limit ${CANDIDATES}`,
    [...filters, toVectorLiteral(vector!), embedder.model],
  );

  // OR of the query's words (sanitised to [a-z0-9]), so a question still finds passages with most of its terms.
  const terms = [...new Set(tokenize(query))].slice(0, 20);
  const keyword = terms.length
    ? await db.query<{ id: string }>(
        `select ch.id from document_chunks ch join documents d on d.id = ch.document_id
         where ${FILTER} and ch.tsv @@ to_tsquery('english', $6)
         order by ts_rank_cd(ch.tsv, to_tsquery('english', $6)) desc limit ${CANDIDATES}`,
        [...filters, terms.join(' | ')],
      )
    : [];

  // Exact identifiers (invoice numbers, account digits): a passage containing them is the strongest signal.
  const codes = identifiers(query);
  const exact = codes.length
    ? await db.query<{ id: string }>(
        `select ch.id from document_chunks ch join documents d on d.id = ch.document_id
         where ${FILTER} and exists (select 1 from unnest($6::text[]) code where position(code in lower(ch.content)) > 0)
         order by (select count(*) from unnest($6::text[]) code where position(code in lower(ch.content)) > 0) desc,
                  ch.document_id, ch.chunk_index
         limit ${CANDIDATES}`,
        [...filters, codes],
      )
    : [];

  const fused = new Map<string, { score: number; matchedBy: Set<'semantic' | 'keyword'> }>();
  const add = (rows: { id: string }[], kind: 'semantic' | 'keyword', weight = 1) =>
    rows.forEach((row, rank) => {
      const entry = fused.get(row.id) ?? { score: 0, matchedBy: new Set() };
      entry.score += weight / (RRF_K + rank + 1);
      entry.matchedBy.add(kind);
      fused.set(row.id, entry);
    });
  add(semantic, 'semantic');
  add(keyword, 'keyword');
  add(exact, 'keyword', 2);

  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score);
  if (ranked.length === 0) return [];

  const details = await db.query<{
    id: string;
    document_id: string;
    title: string;
    client_id: string;
    client_name: string;
    tax_year: number | null;
    doc_type: string | null;
    page: number | null;
    content: string;
  }>(
    `select ch.id, ch.document_id, d.title, d.client_id, c.name as client_name, d.tax_year, d.doc_type, ch.page, ch.content
     from document_chunks ch join documents d on d.id = ch.document_id join clients c on c.id = d.client_id
     where ch.id = any($1::text[]) and ch.firm_id = $2 and d.firm_id = $2`,
    [ranked.map(([id]) => id), firmOf(db)],
  );
  const byId = new Map(details.map((d) => [d.id, d]));

  // Fourth list: the candidates ranked by how many of the question's words they contain. Vectors and full-text
  // each reward a strong match on some words; this rewards matching all of them (the payer AND the form AND the
  // recipient), which is what separates near-identical forms from different issuers.
  const words = [...new Set(tokenize(query))];
  if (words.length > 1) {
    const coverage = ranked
      .map(([id], order) => {
        const tokens = new Set(tokenize(byId.get(id)?.content ?? ''));
        return { id, order, covered: words.filter((w) => tokens.has(w)).length };
      })
      .sort((a, b) => b.covered - a.covered || a.order - b.order);
    add(coverage, 'keyword');
  }
  const reranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score);

  const candidates = reranked.flatMap(([id, { score, matchedBy }]) => {
    const d = byId.get(id);
    return d ? [{ id, documentId: d.document_id, content: d.content, score, matchedBy }] : [];
  });

  return rerankPages(query, candidates)
    .slice(0, options.limit)
    .map(({ id, score, matchedBy }) => {
      const d = byId.get(id)!;
      return {
        chunkId: d.id,
        documentId: d.document_id,
        title: d.title,
        clientId: d.client_id,
        clientName: d.client_name,
        taxYear: d.tax_year === null ? null : Number(d.tax_year),
        docType: d.doc_type,
        page: d.page === null ? null : Number(d.page),
        content: d.content,
        score: Number(score.toFixed(5)),
        matchedBy: [...matchedBy],
      };
    });
}

interface Ranked {
  id: string;
  documentId: string;
  content: string;
  score: number;
}

/**
 * Picks the right page within each document. Fusion decides which documents rank where; but the words that pick a
 * document (client, bank, account number) are printed, or carried in the context line, on every one of its pages,
 * so they can't say which page holds the answer. Within one document, the passages are re-ordered by how many
 * question words they hold that the document's other retrieved passages don't all share ("left at the end of the
 * period" finds the page with the closing balance). Documents keep their positions, so hit rate can't change; only
 * which of a document's passages is cited first.
 */
export function rerankPages<T extends Ranked>(query: string, ranked: T[]): T[] {
  const words = new Set(tokenize(query));
  const groups = new Map<string, number[]>();
  ranked.forEach((r, i) => groups.set(r.documentId, [...(groups.get(r.documentId) ?? []), i]));

  const out = [...ranked];
  for (const positions of groups.values()) {
    if (positions.length < 2) continue;
    const tokens = positions.map((i) => new Set(tokenize(ranked[i]!.content)));
    const shared = new Set([...words].filter((w) => tokens.every((t) => t.has(w))));
    const distinctive = tokens.map((t) => [...words].filter((w) => !shared.has(w) && t.has(w)).length);
    const order = positions
      .map((i, k) => ({ i, k }))
      .sort((a, b) => distinctive[b.k]! - distinctive[a.k]! || a.i - b.i)
      .map((x) => x.i);
    // Each slot keeps its fused score, so the list stays sorted; the passage in it may change.
    positions.forEach((slot, n) => {
      out[slot] = { ...ranked[order[n]!]!, score: ranked[slot]!.score };
    });
  }
  return out;
}
