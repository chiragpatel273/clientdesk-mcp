import {
  EXTRACTION_SYSTEM_PROMPT,
  OutputSchema,
  documentPrompt,
  toExtraction,
  type Output,
} from './extraction-prompt.js';
import { DOC_TYPES, weakestConfidence, type Extraction, type Extractor } from './extraction.js';
import { timedCall } from './usage.js';

/**
 * Extraction through Groq (open-weight models, OpenAI-compatible API, free tier available). Same prompt, output shape
 * and escalation rule as the Claude extractor: the small model first, the larger one only when the first is unsure.
 * Text only: Groq's structured-output models can't read page images, so scans go straight to the review queue.
 */
export const GROQ_SMALL_MODEL = 'openai/gpt-oss-20b';
export const GROQ_LARGE_MODEL = 'openai/gpt-oss-120b';
export const GROQ_ESCALATE_BELOW = 0.8;

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_ATTEMPTS = 8;

// Strict mode: every property listed in `required`, `additionalProperties: false`, nullability as a type array.
const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['doc_type', 'doc_type_confidence', 'client_name', 'tax_year', 'fields'],
  properties: {
    doc_type: { type: 'string', enum: [...DOC_TYPES, 'other'] },
    doc_type_confidence: { type: 'number' },
    client_name: { type: ['string', 'null'] },
    tax_year: { type: ['integer', 'null'] },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value', 'confidence'],
        // Numbers allowed too: the models often write a year or amount as a number, and Groq rejects the whole
        // answer on a type mismatch. Converted to text below.
        properties: {
          name: { type: 'string' },
          value: { type: ['string', 'number', 'null'] },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

/** Field values the model wrote as numbers (2025, 1234.5) become text, which the shared normalisers expect. */
function numbersAsText(raw: unknown): unknown {
  const fields = (raw as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return raw;
  return {
    ...(raw as object),
    fields: fields.map((f: { value?: unknown }) =>
      typeof f?.value === 'number' ? { ...f, value: String(f.value) } : f,
    ),
  };
}

interface ChatResponse {
  choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export interface GroqExtractorOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function groqExtractor(options: GroqExtractorOptions): Extractor {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function post(body: unknown): Promise<ChatResponse> {
    for (let attempt = 1; ; attempt++) {
      const response = await doFetch(API_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        // The free tier allows ~8K tokens a minute per model; Groq says how long to wait.
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
        continue;
      }
      const json = (await response.json().catch(() => ({}))) as ChatResponse;
      if (!response.ok) throw new Error(`Groq ${response.status}: ${json.error?.message ?? response.statusText}`);
      return json;
    }
  }

  async function run(model: string, prompt: string): Promise<Output> {
    const call = (body: unknown) =>
      timedCall(
        { operation: 'extract', provider: 'groq', model, escalated: model === GROQ_LARGE_MODEL },
        () => post(body),
        (res) => ({ inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 }),
      );
    const json = await call({
      model,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'document_extraction', strict: true, schema: JSON_SCHEMA },
      },
      reasoning_effort: model === GROQ_LARGE_MODEL ? 'medium' : 'low',
      max_completion_tokens: 4000,
    });
    const choice = json.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error(`${model} ran out of tokens while extracting`);
    let raw: unknown;
    try {
      raw = JSON.parse(choice?.message?.content ?? '');
    } catch {
      throw new Error(`${model} returned output that was not JSON`);
    }
    const parsed = OutputSchema.safeParse(numbersAsText(raw));
    if (!parsed.success) throw new Error(`${model} returned output that did not match the schema`);
    return parsed.data;
  }

  return {
    name: 'groq',
    async extract(input): Promise<Extraction> {
      if (!input.textLayer) {
        // No text to read and no vision model: zero confidence sends it to a person.
        const model = `${GROQ_SMALL_MODEL} (scan: not read)`;
        return { docType: 'other', docTypeConfidence: 0, clientName: null, taxYear: null, fields: [], model };
      }
      const prompt = documentPrompt(input);
      // A failed answer from the small model (bad JSON, schema mismatch) is another reason to ask the large one.
      const first = await run(GROQ_SMALL_MODEL, prompt)
        .then((output) => toExtraction(output, GROQ_SMALL_MODEL))
        .catch(() => null);
      if (first && weakestConfidence(first) >= GROQ_ESCALATE_BELOW) return first;
      return toExtraction(await run(GROQ_LARGE_MODEL, prompt), `${GROQ_SMALL_MODEL} → ${GROQ_LARGE_MODEL}`);
    },
  };
}
