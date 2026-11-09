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

/** A page with fewer characters than this is treated as having no text layer. */
const MIN_PAGE_CHARS = 40;

type TextItem = { str: string; transform: number[] };

/** Rebuilds reading-order lines from pdf.js text items (grouped by baseline, left to right). */
function pageToText(items: TextItem[]): string {
  const lines = new Map<number, { x: number; str: string }[]>();
  for (const item of items) {
    if (!item.str) continue;
    const y = Math.round(item.transform[5] ?? 0);
    const x = item.transform[4] ?? 0;
    const key = [...lines.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
    const line = lines.get(key) ?? [];
    line.push({ x, str: item.str });
    lines.set(key, line);
  }
  return [...lines.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, parts]) =>
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
    const pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(pageToText(content.items.flatMap((i) => ('str' in i ? [{ str: i.str, transform: i.transform }] : []))));
    }
    const withText = pages.filter((p) => p.length >= MIN_PAGE_CHARS).length;
    return { pages, textLayer: withText >= Math.ceil(pages.length / 2) };
  } finally {
    await task.destroy();
  }
}

/** Plain-text uploads: a form feed (\f) separates pages, as `pdftotext` writes them. */
export function extractPlainText(bytes: Uint8Array): ExtractedText {
  const pages = new TextDecoder().decode(bytes).split('\f');
  return { pages: pages.map((p) => p.trim()), textLayer: true };
}

export async function extractText(bytes: Uint8Array, mimeType: string): Promise<ExtractedText> {
  if (mimeType === 'application/pdf') return extractPdfText(bytes);
  if (mimeType === 'text/plain') return extractPlainText(bytes);
  throw new Error(`Unsupported file type: ${mimeType}`);
}
