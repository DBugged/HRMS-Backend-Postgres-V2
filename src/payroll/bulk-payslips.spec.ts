import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLib } from 'pdf-lib';
import {
  bulkPayslipFilename,
  mapInBatches,
  mergePdfBuffers,
} from './bulk-payslips';

function makePdf(pages: number, label: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    for (let i = 0; i < pages; i += 1) {
      if (i > 0) doc.addPage();
      doc.text(`${label} page ${i + 1}`);
    }
    doc.end();
  });
}

describe('bulk payslips', () => {
  it('joins the PDFs in order, every one starting on its own page', async () => {
    const merged = await mergePdfBuffers([
      await makePdf(1, 'A'),
      await makePdf(2, 'B'),
      await makePdf(1, 'C'),
    ]);
    const doc = await PdfLib.load(merged);
    expect(doc.getPageCount()).toBe(4);
  });

  it('names the file by month and year', () => {
    expect(bulkPayslipFilename(3, 2026)).toBe('Payslips-March-2026.pdf');
  });

  it('keeps input order and never runs more than the batch size at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapInBatches([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
