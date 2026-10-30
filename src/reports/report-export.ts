import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import { attachWatermark } from '../common/pdf-watermark';

// Pure port of the original release's reportController module export helpers —
// every report in this module funnels through sendReport so Excel/CSV/PDF
// handling stays consistent and in one place.

export interface ReportColumn {
  header: string;
  key: string;
  width?: number;
}

export type ReportFormat = 'xlsx' | 'csv' | 'pdf';

// ExcelJS's addImage only accepts these three raster formats — sniffed from
// the file's magic bytes rather than trusting a stored extension/mimetype,
// since branding uploads accept any image type (an SVG or WEBP Report Logo
// is valid to upload, just not embeddable here). Returns null for anything
// else, and every caller treats that as "skip the logo" rather than erroring.
export function detectRasterExtension(
  buffer: Buffer,
): 'png' | 'jpeg' | 'gif' | null {
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'jpeg';
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'gif';
  }
  return null;
}

// Spreadsheet apps evaluate a cell that starts with = + - @ (or a leading
// tab/CR) as a formula. Prefixing such strings with an apostrophe forces
// them to be read as literal text (CSV/formula injection). Idempotent.
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
// A lone dash ("no value"), a signed number ("-250", "+91 98765 43210") is data, not a formula: guarding it put a
// visible apostrophe in front of every empty cell ("'-"). Anything with an operator or letters after the sign still is.
const PLAIN_SIGNED_VALUE_RE = /^(?:[+-]\s*[\d.,\s]*|-+)$/;
export function sanitizeSpreadsheetValue<T>(value: T): T {
  if (
    typeof value === 'string' &&
    FORMULA_TRIGGER_RE.test(value) &&
    !PLAIN_SIGNED_VALUE_RE.test(value)
  ) {
    return `'${value}` as T;
  }
  return value;
}

function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = sanitizeSpreadsheetValue(value);
  }
  return out;
}

function sanitizeWorkbookCells(workbook: ExcelJS.Workbook): void {
  workbook.eachSheet((ws) =>
    ws.eachRow((r) =>
      r.eachCell((cell) => {
        if (typeof cell.value === 'string') {
          cell.value = sanitizeSpreadsheetValue(cell.value);
        }
      }),
    ),
  );
}

// Excel limits: a sheet name is at most 31 characters and cannot hold : \\ / ? * [ ].
function sheetNameOf(title: string): string {
  return (
    title
      .replace(/[:\\/?*[\]]/g, ' ')
      .slice(0, 31)
      .trim() || 'Report'
  );
}

// A column wide enough for its header and its longest value (in characters), within sensible limits.
function fitWidth(
  column: ReportColumn,
  rows: Record<string, unknown>[],
): number {
  let longest = column.header.length;
  for (const row of rows.slice(0, 500)) {
    const value = row[column.key];
    const text =
      value instanceof Date
        ? value.toISOString().slice(0, 10)
        : typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : '';
    if (text.length > longest) longest = text.length;
  }
  return Math.min(50, Math.max(column.width ?? 10, longest + 2));
}

export function buildWorkbook(
  title: string,
  columns: ReportColumn[],
  rows: Record<string, unknown>[],
  subtitle?: string,
  logoBuffer?: Buffer | null,
  // A CSV is the bare table (header on line 1); an .xlsx is laid out for reading: logo, title and subtitle each on
  // their own row above the table, then a styled header that stays in view and filters, and columns sized to fit.
  opts: { styled?: boolean } = {},
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetNameOf(title));
  sheet.columns = columns.map((c) => ({
    key: c.key,
    width: opts.styled ? fitWidth(c, rows) : c.width,
  }));

  if (!opts.styled) {
    sheet.addRow(columns.map((c) => c.header)).font = { bold: true };
    rows.forEach((row) => sheet.addRow(sanitizeRow(row)));
    return workbook;
  }

  let next = 1;
  const extension = logoBuffer ? detectRasterExtension(logoBuffer) : null;
  if (logoBuffer && extension) {
    // The logo gets a row of its own: it used to float over the subtitle and the first header.
    const imageId = workbook.addImage({
      buffer: logoBuffer as unknown as ExcelJS.Buffer,
      extension,
    });
    sheet.addImage(imageId, {
      tl: { col: 0.1, row: 0.1 },
      ext: { width: 48, height: 48 },
    });
    sheet.getRow(1).height = 42;
    next = 2;
  }
  const titleCell = sheet.getCell(next, 1);
  titleCell.value = sanitizeSpreadsheetValue(title);
  titleCell.font = { bold: true, size: 14 };
  sheet.getRow(next).height = 22;
  next += 1;
  if (subtitle) {
    const subtitleCell = sheet.getCell(next, 1);
    subtitleCell.value = sanitizeSpreadsheetValue(subtitle);
    subtitleCell.font = { italic: true, color: { argb: 'FF555555' } };
    next += 1;
  }
  next += 1; // a blank line before the table

  const headerRowNo = next;
  const headerRow = sheet.getRow(headerRowNo);
  headerRow.values = columns.map((c) => c.header);
  headerRow.height = 32;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEFEFF5' },
    };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF9A9AB0' } } };
  });
  rows.forEach((row) => {
    sheet.addRow(sanitizeRow(row)).alignment = { vertical: 'top' };
  });
  sheet.views = [{ state: 'frozen', ySplit: headerRowNo }];
  sheet.autoFilter = {
    from: { row: headerRowNo, column: 1 },
    to: { row: headerRowNo, column: Math.max(1, columns.length) },
  };
  return workbook;
}

// Renders a simple table-style PDF for a report (header row + rows),
// paginating when content overflows a page.
export function renderPdfTable(
  res: Response,
  title: string,
  columns: ReportColumn[],
  rows: Record<string, unknown>[],
  filename: string,
  subtitle?: string,
  logoBuffer?: Buffer | null,
  watermarkEnabled?: boolean,
): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}.pdf`);

  const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
  doc.pipe(res);
  if (watermarkEnabled) attachWatermark(doc, logoBuffer);

  if (logoBuffer) {
    try {
      // pdfkit only decodes PNG/JPEG — an SVG or WEBP Report Logo (branding
      // uploads accept any image type) throws here; caught and skipped
      // rather than failing the whole report, same convention payslip-pdf
      // .service.ts already uses for the payslip's own company logo.
      doc.image(logoBuffer, 30, 20, { fit: [36, 36] });
    } catch {
      // Unsupported image format — continue without a logo.
    }
  }
  doc.fontSize(16).text(title, { align: 'center' });
  if (subtitle) {
    doc
      .fontSize(9)
      .font('Helvetica-Oblique')
      .text(subtitle, { align: 'center' });
    doc.font('Helvetica');
  }
  doc.moveDown(0.5);

  const pageWidth = doc.page.width - 60;
  const colWidth = pageWidth / columns.length;
  const startX = 30;
  let y = doc.y;

  // Cells wrap onto extra lines (nothing is cut off with an ellipsis); a row that would not fit the page moves to the
  // next one, and the header row is repeated at the top of every page.
  const headerValues = columns.map((c) => c.header);
  const drawRow = (
    values: (string | number | boolean | null | undefined)[],
    isHeader = false,
  ) => {
    doc.fontSize(8).font(isHeader ? 'Helvetica-Bold' : 'Helvetica');
    const texts = values.map((val) => String(val ?? ''));
    const textWidth = colWidth - 5;
    const rowHeight = Math.max(
      16,
      ...texts.map((t) => doc.heightOfString(t, { width: textWidth }) + 6),
    );
    if (!isHeader && y + rowHeight > doc.page.height - 40) {
      doc.addPage();
      y = 40;
      drawRow(headerValues, true);
      doc.fontSize(8).font('Helvetica');
    }
    texts.forEach((t, i) => {
      doc.text(t, startX + i * colWidth, y, { width: textWidth });
    });
    y += rowHeight;
  };

  drawRow(headerValues, true);
  doc
    .moveTo(startX, y - 4)
    .lineTo(startX + pageWidth, y - 4)
    .stroke();

  rows.forEach((row) => {
    drawRow(
      columns.map(
        (c) => row[c.key] as string | number | boolean | null | undefined,
      ),
    );
  });

  doc.end();
}

export interface SendReportInput {
  title: string;
  subtitle?: string;
  // Org's Branding > Report Logo, already read as bytes — see
  // report-branding.ts's sendReportBranded(), the entry point every
  // report controller actually calls (this stays a plain optional field
  // here so report-export.ts itself never needs to know about Prisma/file
  // storage).
  logoBuffer?: Buffer | null;
  // Organization Settings > Branding > "Watermark this logo on generated
  // documents" — same org-level toggle letters/payslips honor. PDF export
  // only; csv/xlsx have no page to watermark.
  watermarkEnabled?: boolean;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  filename: string;
  format: ReportFormat;
}

// Single entry point used by every report in this module. Prefer
// sendReportBranded() (report-branding.ts) at actual call sites — it wraps
// this with the org's Report Logo already resolved.
export async function sendReport(
  res: Response,
  {
    title,
    subtitle,
    logoBuffer,
    watermarkEnabled,
    columns,
    rows,
    filename,
    format,
  }: SendReportInput,
): Promise<void> {
  if (format === 'pdf') {
    renderPdfTable(
      res,
      title,
      columns,
      rows,
      filename,
      subtitle,
      logoBuffer,
      watermarkEnabled,
    );
    return;
  }
  // A CSV is for machines: the header must be line 1, so the title, subtitle and logo are left out of it.
  const workbook =
    format === 'csv'
      ? buildWorkbook(title, columns, rows)
      : buildWorkbook(title, columns, rows, subtitle, logoBuffer, {
          styled: true,
        });
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=${filename}.csv`,
    );
    sanitizeWorkbookCells(workbook);
    const csv = await workbook.csv.writeBuffer();
    // UTF-8 BOM so Excel detects the encoding (non-ASCII names etc.).
    const buffer = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(csv),
    ]);
    res.send(buffer);
  } else {
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=${filename}.xlsx`,
    );
    const buffer = await workbook.xlsx.writeBuffer();
    res.send(buffer);
  }
}
