import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const STANDARD_FONTS = join(
  dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
  'standard_fonts/',
);

export interface ExtractedText {
  /** One entry per page, in order. Empty strings for pages without a text layer. */
  pages: string[];
  /** False when most pages have no usable text: a scan or photo, which needs a vision model. */
  textLayer: boolean;
}

/** More than any document a firm receives; enough to stop one file from tying up the server. */
const MAX_PAGES = 300;
const MAX_CHARS = 500_000;

export class DocumentTooLargeError extends Error {
  override name = 'DocumentTooLargeError';
}

function checkSize(pages: number, chars: number): void {
  if (pages > MAX_PAGES) throw new DocumentTooLargeError(`The document has more than ${MAX_PAGES} pages`);
  if (chars > MAX_CHARS) throw new DocumentTooLargeError(`The document has more than ${MAX_CHARS} characters of text`);
}

/** A page with fewer characters than this is treated as having no text layer. */
const MIN_PAGE_CHARS = 40;

type TextItem = { str: string; transform: number[] };

/** Rebuilds reading-order lines from pdf.js text items (grouped by baseline, left to right). */
function pageToText(items: TextItem[]): string {
  const lines = new Map<number, { order: number; parts: { x: number; str: string }[] }>();
  for (const item of items) {
    if (!item.str) continue;
    const y = Math.round(item.transform[5] ?? 0);
    const x = item.transform[4] ?? 0;
    // The line within 2 points that started first (looked up, not searched: a page can have tens of thousands of lines).
    const near = [y, y + 1, y - 1, y + 2, y - 2].map((k) => lines.get(k)).filter((l) => l !== undefined);
    const line = near.length ? near.reduce((a, b) => (a.order <= b.order ? a : b)) : { order: lines.size, parts: [] };
    line.parts.push({ x, str: item.str });
    if (!near.length) lines.set(y, line);
  }
  return [...lines.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, { parts }]) =>
      parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedText> {
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const task = getDocument({
    data: bytes.slice(),
    standardFontDataUrl: STANDARD_FONTS,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    checkSize(pdf.numPages, 0);
    const pages: string[] = [];
    let chars = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      checkSize(
        n,
        content.items.reduce((total, i) => total + ('str' in i ? i.str.length : 0), chars),
      );
      pages.push(
        pageToText(content.items.flatMap((i) => ('str' in i ? [{ str: i.str, transform: i.transform }] : []))),
      );
      checkSize(n, (chars += pages.at(-1)!.length));
    }
    const withText = pages.filter((p) => p.length >= MIN_PAGE_CHARS).length;
    return { pages, textLayer: withText >= Math.ceil(pages.length / 2) };
  } finally {
    await task.destroy();
  }
}

/** Plain-text uploads: a form feed (\f) separates pages, as `pdftotext` writes them. */
export function extractPlainText(bytes: Uint8Array): ExtractedText {
  const text = new TextDecoder().decode(bytes);
  const pages = text.split('\f');
  checkSize(pages.length, text.length);
  return { pages: pages.map((p) => p.trim()), textLayer: true };
}

export async function extractText(bytes: Uint8Array, mimeType: string): Promise<ExtractedText> {
  if (mimeType === 'application/pdf') return extractPdfText(bytes);
  if (mimeType === 'text/plain') return extractPlainText(bytes);
  throw new Error(`Unsupported file type: ${mimeType}`);
}
