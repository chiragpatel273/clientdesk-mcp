import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Renders plain text pages into a simple PDF with a real text layer. Used for the demo documents and the
 * eval set, so they go through the same pdf.js path as uploads.
 */
export async function renderTextPdf(title: string, pages: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('ClientDesk demo generator');
  pdf.setCreationDate(new Date('2026-11-01T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-11-01T00:00:00Z'));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const text of pages) {
    const page = pdf.addPage([595, 842]); // A4 in points
    let y = 790;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const isHeading = i === 0;
      page.drawText(sanitize(line), {
        x: 56,
        y,
        size: isHeading ? 15 : 10.5,
        font: isHeading ? bold : font,
        color: rgb(0.12, 0.12, 0.14),
      });
      y -= isHeading ? 26 : 16;
    });
  }
  return pdf.save();
}

/** Helvetica (WinAnsi) can't encode every character; replace the few the generators might produce. */
function sanitize(line: string): string {
  return line
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e\xa0-\xff€]/g, '?');
}
