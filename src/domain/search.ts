import { tokenize, toVectorLiteral, type Embedder } from '../ai/embeddings.js';
import type { Db } from '../db/index.js';

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

// Shared filter: filed documents only, inside the caller's access list, plus optional filters.
const FILTER = `d.status = 'filed'
  and ($1::text[] is null or d.client_id = any($1::text[]))
  and ($2::text is null or d.client_id = $2)
  and ($3::int is null or d.tax_year = $3)
  and ($4::text is null or d.doc_type = $4)`;

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
    options.allowedClientIds === 'all' ? null : options.allowedClientIds,
    options.clientId ?? null,
    options.taxYear ?? null,
    options.docType ?? null,
  ];

  const [vector] = await embedder.embed([query], 'query');
  const semantic = await db.query<{ id: string }>(
    `select ch.id from document_chunks ch join documents d on d.id = ch.document_id
     where ${FILTER} and ch.embedding_model = $6
     order by ch.embedding <=> $5::vector limit ${CANDIDATES}`,
    [...filters, toVectorLiteral(vector!), embedder.model],
  );

  // OR of the query's words (sanitised to [a-z0-9]), so a question still finds passages with most of its terms.
  const terms = [...new Set(tokenize(query))].slice(0, 20);
  const keyword = terms.length
    ? await db.query<{ id: string }>(
        `select ch.id from document_chunks ch join documents d on d.id = ch.document_id
         where ${FILTER} and ch.tsv @@ to_tsquery('english', $5)
         order by ts_rank_cd(ch.tsv, to_tsquery('english', $5)) desc limit ${CANDIDATES}`,
        [...filters, terms.join(' | ')],
      )
    : [];

  // Exact identifiers (invoice numbers, account digits): a passage containing them is the strongest signal.
  const codes = identifiers(query);
  const exact = codes.length
    ? await db.query<{ id: string }>(
        `select ch.id from document_chunks ch join documents d on d.id = ch.document_id
         where ${FILTER} and exists (select 1 from unnest($5::text[]) code where position(code in lower(ch.content)) > 0)
         order by (select count(*) from unnest($5::text[]) code where position(code in lower(ch.content)) > 0) desc,
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

  const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, options.limit);
  if (top.length === 0) return [];

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
     where ch.id = any($1::text[])`,
    [top.map(([id]) => id)],
  );
  const byId = new Map(details.map((d) => [d.id, d]));
  return top.flatMap(([id, { score, matchedBy }]) => {
    const d = byId.get(id);
    if (!d) return [];
    return [
      {
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
      },
    ];
  });
}
