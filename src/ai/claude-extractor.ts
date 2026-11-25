import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  EXTRACTION_SYSTEM_PROMPT,
  OutputSchema,
  documentPrompt,
  toExtraction,
  type Output,
} from './extraction-prompt.js';
import { weakestConfidence, type ExtractionInput, type Extractor } from './extraction.js';
import { timedCall } from './usage.js';

/** Small, cheap model first; the larger one only when the first is unsure. */
export const SMALL_MODEL = 'claude-haiku-5-5';
export const LARGE_MODEL = 'claude-opus-5-5';
/** Below this (on the type or any required field) the larger model gets a second look. */
export const ESCALATE_BELOW = 0.8;

function userContent(input: ExtractionInput): Anthropic.Beta.BetaContentBlockParam[] {
  const label = input.filename ? ` (file: ${input.filename})` : '';
  if (!input.textLayer && input.pdf) {
    // Scans and photos: send the PDF itself; Claude reads the page images.
    return [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(input.pdf).toString('base64') },
      },
      { type: 'text', text: `Extract the fields from this scanned document${label}.` },
    ];
  }
  return [{ type: 'text', text: documentPrompt(input) }];
}

export function claudeExtractor(options: { apiKey?: string; client?: Anthropic } = {}): Extractor {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });

  async function run(model: string, input: ExtractionInput): Promise<Output> {
    const large = model === LARGE_MODEL;
    const response = await timedCall(
      { operation: 'extract', provider: 'anthropic', model, escalated: large },
      () =>
        client.beta.messages.parse({
          model,
          max_tokens: 16000,
          system: [{ type: 'text', text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: userContent(input) }],
          output_config: { format: betaZodOutputFormat(OutputSchema), effort: large ? 'medium' : 'low' },
          // On a safety decline the API re-runs the request on a fallback model instead of failing.
          ...(large ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        }),
      // Cache writes and reads are counted as input at the full rate: a slight overestimate (see prices.ts).
      (r) => ({
        inputTokens:
          r.usage.input_tokens + (r.usage.cache_creation_input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0),
        outputTokens: r.usage.output_tokens,
      }),
    );
    if (response.stop_reason === 'refusal') throw new Error(`${model} declined to extract this document`);
    if (response.stop_reason === 'max_tokens') throw new Error(`${model} ran out of tokens while extracting`);
    if (!response.parsed_output) throw new Error(`${model} returned output that did not match the schema`);
    return response.parsed_output;
  }

  return {
    name: 'claude',
    async extract(input) {
      const first = toExtraction(await run(SMALL_MODEL, input), SMALL_MODEL);
      if (weakestConfidence(first) >= ESCALATE_BELOW) return first;
      return toExtraction(await run(LARGE_MODEL, input), `${SMALL_MODEL} → ${LARGE_MODEL}`);
    },
  };
}
