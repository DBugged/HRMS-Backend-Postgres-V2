import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Response } from 'express';

// Pure port of the old backend's reportController.js export helpers —
// every report in this module funnels through sendReport so Excel/CSV/PDF
// handling stays consistent and in one place.

export interface ReportColumn {
  header: string;
  key: string;
  width?: number;
}

export type ReportFormat = 'xlsx' | 'csv' | 'pdf';

export function buildWorkbook(
  title: string,
  columns: ReportColumn[],
  rows: Record<string, unknown>[],
  subtitle?: string,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title);
  sheet.columns = columns;
  rows.forEach((row) => sheet.addRow(row));
  sheet.getRow(1).font = { bold: true };
  if (subtitle) {
    // Inserted above the (already-written) header row — insertRow shifts
    // the header and every data row down by one, same as the old system's
    // report exports carrying a "which establishment this belongs to" line.
    // Deliberately NOT merged across columns — mergeCells is an Excel-only
    // concept, and this same worksheet also backs the CSV export, whose
    // writer repeats a merged cell's value into every column instead of
    // leaving them blank. A single-cell first column reads fine in Excel
    // too, just without the visual merge.
    sheet.insertRow(1, [subtitle]);
    sheet.getRow(1).font = { italic: true, bold: false };
    sheet.getRow(2).font = { bold: true };
  }
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
): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}.pdf`);

  const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
  doc.pipe(res);

  doc.fontSize(16).text(title, { align: 'center' });
  if (subtitle) {
    doc.fontSize(9).font('Helvetica-Oblique').text(subtitle, { align: 'center' });
    doc.font('Helvetica');
  }
  doc.moveDown(0.5);

  const pageWidth = doc.page.width - 60;
  const colWidth = pageWidth / columns.length;
  const startX = 30;
  let y = doc.y;

  const drawRow = (
    values: (string | number | boolean | null | undefined)[],
    isHeader = false,
  ) => {
    doc.fontSize(8).font(isHeader ? 'Helvetica-Bold' : 'Helvetica');
    values.forEach((val, i) => {
      doc.text(String(val ?? ''), startX + i * colWidth, y, {
        width: colWidth - 5,
        ellipsis: true,
      });
    });
    y += 16;
    if (y > doc.page.height - 40) {
      doc.addPage();
      y = 40;
    }
  };

  drawRow(
    columns.map((c) => c.header),
    true,
  );
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
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  filename: string;
  format: ReportFormat;
}

// Single entry point used by every report in this module.
export async function sendReport(
  res: Response,
  { title, subtitle, columns, rows, filename, format }: SendReportInput,
): Promise<void> {
  if (format === 'pdf') {
    renderPdfTable(res, title, columns, rows, filename, subtitle);
    return;
  }
  const workbook = buildWorkbook(title, columns, rows, subtitle);
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=${filename}.csv`,
    );
    const buffer = await workbook.csv.writeBuffer();
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
