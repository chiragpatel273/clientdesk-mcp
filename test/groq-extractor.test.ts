import { describe, expect, it } from 'vitest';
import { FIELDS } from '../src/ai/extraction.js';
import { GROQ_LARGE_MODEL, GROQ_SMALL_MODEL, groqExtractor } from '../src/ai/groq-extractor.js';

const input = { filename: 'inv.pdf', pages: ['INVOICE\nBilled to: Acme Ltd'], textLayer: true, pdf: null };

function output(confidence: number) {
  return {
    doc_type: 'invoice',
    doc_type_confidence: 0.98,
    client_name: 'Acme Ltd',
    tax_year: 2026,
    // Every invoice field, as the strict schema makes the model return them.
    fields: FIELDS.invoice.map((f) => ({
      name: f.name,
      value: f.name === 'billed_to' ? 'Acme Ltd' : null,
      confidence,
    })),
  };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }] }), {
    status: 200,
  });

/** A fake Groq: answers from a queue of responses and records each request body. */
function fakeGroq(responses: Response[]) {
  const requests: { model: string; response_format: { json_schema: { strict: boolean } } }[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  }) as typeof globalThis.fetch;
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  return { extractor: groqExtractor({ apiKey: 'test', fetch, sleep }), requests, waits };
}

describe('groq extractor', () => {
  it('uses the small model with a strict schema when it is confident', async () => {
    const groq = fakeGroq([ok(output(0.95))]);
    const result = await groq.extractor.extract(input);
    expect(result).toMatchObject({ docType: 'invoice', clientName: 'Acme Ltd', model: GROQ_SMALL_MODEL });
    expect(groq.requests).toHaveLength(1);
    expect(groq.requests[0]).toMatchObject({
      model: GROQ_SMALL_MODEL,
      response_format: { json_schema: { strict: true } },
    });
  });

  it('escalates to the large model when unsure', async () => {
    const groq = fakeGroq([ok(output(0.5)), ok(output(0.97))]);
    const result = await groq.extractor.extract(input);
    expect(groq.requests.map((r) => r.model)).toEqual([GROQ_SMALL_MODEL, GROQ_LARGE_MODEL]);
    expect(result.model).toBe(`${GROQ_SMALL_MODEL} → ${GROQ_LARGE_MODEL}`);
  });

  it('waits out rate limits using retry-after', async () => {
    const limited = new Response('{}', { status: 429, headers: { 'retry-after': '7' } });
    const groq = fakeGroq([limited, ok(output(0.95))]);
    await groq.extractor.extract(input);
    expect(groq.waits).toEqual([7000]);
  });

  it('fails clearly when both models fail', async () => {
    const denied = () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 });
    await expect(fakeGroq([denied(), denied()]).extractor.extract(input)).rejects.toThrow('Groq 401: Invalid API Key');
    const broken = fakeGroq([ok({ doc_type: 'invoice' }), ok({ doc_type: 'invoice' })]);
    await expect(broken.extractor.extract(input)).rejects.toThrow(/did not match/);
  });

  it('asks the large model when the small one returns a broken answer', async () => {
    const groq = fakeGroq([ok({ doc_type: 'invoice' }), ok(output(0.97))]);
    const result = await groq.extractor.extract(input);
    expect(groq.requests.map((r) => r.model)).toEqual([GROQ_SMALL_MODEL, GROQ_LARGE_MODEL]);
    expect(result.clientName).toBe('Acme Ltd');
  });

  it('accepts field values written as numbers', async () => {
    const body = output(0.95);
    body.fields = body.fields.map((f) =>
      f.name === 'total_amount' ? { ...f, value: 1234.5 as unknown as string } : f,
    );
    const result = await fakeGroq([ok(body)]).extractor.extract(input);
    expect(result.fields.find((f) => f.name === 'total_amount')?.value).toBe('1234.50');
  });

  it('sends scans to review without calling the API', async () => {
    const groq = fakeGroq([]);
    const result = await groq.extractor.extract({ filename: null, pages: [''], textLayer: false, pdf: null });
    expect(result).toMatchObject({ docType: 'other', docTypeConfidence: 0 });
    expect(groq.requests).toHaveLength(0);
  });
});
