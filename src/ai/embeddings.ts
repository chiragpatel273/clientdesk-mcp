import type { Config } from '../config.js';

export const EMBEDDING_DIMS = 1024; // matches document_chunks.embedding vector(1024)

export interface Embedder {
  /** Stored with every vector; only vectors from the same model are ever compared. */
  readonly model: string;
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

const STOPWORDS = new Set(
  'a an and are as at be by for from has have i in is it its of on or that the this to was were will with what which who our your their there these those than then do does did not no'.split(
    ' ',
  ),
);

/** Lowercases, splits on non-word characters, drops stopwords and applies a very light stemmer. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 ? t.replace(/(ings?|ed|es|s)$/, '') : t));
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A deterministic bag-of-words embedder (feature hashing of unigrams and bigrams). No network, no cost.
 * It only captures word overlap, not meaning: good enough for tests and offline demos; Voyage is used for real.
 */
export function localEmbedder(): Embedder {
  const embedOne = (text: string): number[] => {
    const vector = new Array<number>(EMBEDDING_DIMS).fill(0);
    const tokens = tokenize(text);
    const features = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]}_${t}`)];
    const counts = new Map<string, number>();
    for (const f of features) counts.set(f, (counts.get(f) ?? 0) + 1);
    for (const [feature, count] of counts) {
      const h = fnv1a(feature);
      const sign = h & 1 ? 1 : -1;
      vector[h % EMBEDDING_DIMS]! += sign * (1 + Math.log(count)) * (feature.includes('_') ? 0.5 : 1);
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((v) => v / norm);
  };
  return {
    model: 'local-hash-v1',
    async embed(texts) {
      return texts.map(embedOne);
    },
  };
}

/** Voyage AI embeddings (https://docs.voyageai.com/reference/embeddings-api). */
export function voyageEmbedder(apiKey: string, model = 'voyage-3.5'): Embedder {
  const BATCH = 64;
  return {
    model,
    async embed(texts, kind) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const res = await fetch('https://api.voyageai.com/v1/embeddings', {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            input: texts.slice(i, i + BATCH),
            model,
            input_type: kind,
            output_dimension: EMBEDDING_DIMS,
          }),
        });
        if (!res.ok) throw new Error(`Voyage embeddings failed (${res.status})`);
        const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
        out.push(...body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
      }
      return out;
    },
  };
}

export function createEmbedder(config: Config): Embedder {
  return config.embeddings === 'voyage' ? voyageEmbedder(config.voyageApiKey!) : localEmbedder();
}

/** pgvector's text input format. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',')}]`;
}
