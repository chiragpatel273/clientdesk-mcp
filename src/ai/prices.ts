/**
 * Model prices in US dollars per million tokens: the one place to update when a provider changes its prices. Costs on
 * the Usage page are estimates from these numbers and the token counts each API reports.
 *
 * Checked 2026-11-19: Anthropic from the Claude API model table; Groq and Voyage from their published rates as listed
 * by price trackers (Groq: groq.com/pricing, Voyage: docs.voyageai.com/docs/pricing). Prompt-cache discounts and
 * Anthropic's long-prompt Haiku rate (over 100K tokens) are not modelled: our prompts are a few thousand tokens.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'openai/gpt-oss-20b': { input: 0.075, output: 0.3 },
  'openai/gpt-oss-120b': { input: 0.15, output: 0.6 },
  'voyage-3.5': { input: 0.06, output: 0 },
  // Offline: run on this machine, free.
  'rules-v1': { input: 0, output: 0 },
  'local-hash-v1': { input: 0, output: 0 },
};

/** Estimated cost in dollars; an unknown model costs 0 and says so in the result. */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): { usd: number; known: boolean } {
  const price = PRICES[model];
  if (!price) return { usd: 0, known: false };
  return { usd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000, known: true };
}
