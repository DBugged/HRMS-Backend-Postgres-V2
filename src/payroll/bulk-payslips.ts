// Purpose: The pure pieces of "download every payslip of a month as one PDF": joining the individually drawn payslips,
//   the file name, the size cap and a small concurrency helper.
// Important: each payslip is drawn exactly as the single-payslip download draws it (so the layout can't differ); this file
//   only concatenates the resulting PDFs. Every payslip therefore starts on a new page.
import { PDFDocument } from 'pdf-lib';

// A month with more payslips than this is refused with a clear message: the PDF is built in memory in one request.
export const BULK_PAYSLIP_MAX = 1500;
// How many payslips are drawn at the same time.
export const BULK_PAYSLIP_CONCURRENCY = 6;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function bulkPayslipFilename(month: number, year: number): string {
  return `Payslips-${MONTH_NAMES[month - 1] ?? month}-${year}.pdf`;
}

// Joins PDFs in the given order; each input's pages are copied whole, so each payslip starts on a new page.
export async function mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return Buffer.from(await out.save());
}

// Runs `fn` over `items` with at most `size` in flight at once, keeping the input order in the result.
export async function mapInBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return results;
}
