import { PassThrough } from 'stream';
import {
  buildWorkbook,
  renderPdfTable,
  sanitizeSpreadsheetValue,
  sendReport,
} from './report-export';

describe('sanitizeSpreadsheetValue', () => {
  it('guards text that a spreadsheet would run as a formula', () => {
    expect(sanitizeSpreadsheetValue('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(sanitizeSpreadsheetValue('@cmd')).toBe("'@cmd");
    expect(sanitizeSpreadsheetValue('+cmd|calc')).toBe("'+cmd|calc");
    expect(sanitizeSpreadsheetValue('-2+3')).toBe("'-2+3");
    expect(sanitizeSpreadsheetValue('-2-3')).toBe("'-2-3");
    expect(sanitizeSpreadsheetValue('-1-1 Minus')).toBe("'-1-1 Minus");
    expect(sanitizeSpreadsheetValue('\tcmd')).toBe("'\tcmd");
  });

  it('leaves an empty-value dash alone instead of showing "\'-"', () => {
    expect(sanitizeSpreadsheetValue('-')).toBe('-');
    expect(sanitizeSpreadsheetValue('--')).toBe('--');
  });

  it('leaves signed numbers and phone numbers alone', () => {
    expect(sanitizeSpreadsheetValue('-250')).toBe('-250');
    expect(sanitizeSpreadsheetValue('-1,250.50')).toBe('-1,250.50');
    expect(sanitizeSpreadsheetValue('+91 98765 43210')).toBe('+91 98765 43210');
  });

  it('leaves ordinary text and non-strings alone', () => {
    expect(sanitizeSpreadsheetValue('Basic Salary')).toBe('Basic Salary');
    expect(sanitizeSpreadsheetValue(42)).toBe(42);
    expect(sanitizeSpreadsheetValue(null)).toBeNull();
  });
});

describe('report export layout', () => {
  const columns = [
    { header: 'Name', key: 'name' },
    { header: 'Notes', key: 'notes' },
  ];

  it('puts the CSV header on line 1 (the subtitle is left out of a CSV)', async () => {
    let body = '';
    const res = {
      setHeader: () => undefined,
      send: (b: Buffer) => {
        body = b.toString('utf8');
      },
    };
    await sendReport(res as never, {
      title: 'T',
      subtitle: 'Establishment: Example Co',
      columns,
      rows: [{ name: 'A', notes: 'x' }],
      filename: 'f',
      format: 'csv',
    });
    const text = body.replace(/^\uFEFF/, '');
    expect(text.split('\n')[0]).toBe('Name,Notes');
    expect(text).not.toContain('Establishment');
  });

  it('wraps long PDF cells and flows onto more pages without throwing', async () => {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    const res = Object.assign(out, { setHeader: () => undefined });
    const longText = 'word '.repeat(80);
    renderPdfTable(
      res as never,
      'T',
      columns,
      Array.from({ length: 60 }, (_, i) => ({
        name: `Row ${i}`,
        notes: longText,
      })),
      'f',
    );
    await new Promise((r) => out.on('end', r));
    const pdf = Buffer.concat(chunks).toString('latin1');
    expect(pdf.startsWith('%PDF')).toBe(true);
    expect((pdf.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(3);
  });
});

describe('xlsx layout', () => {
  // A 1x1 PNG, enough to be embedded.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const columns = [
    { header: 'UAN', key: 'uan', width: 10 },
    { header: 'EPF Contribution (Employee)', key: 'epf', width: 10 },
  ];
  const rows = [{ uan: '100123456789', epf: 1800 }];

  it('puts the logo, title and subtitle on rows of their own above a styled, frozen, filterable header', () => {
    const wb = buildWorkbook(
      'PF ECR',
      columns,
      rows,
      'Establishment Code: PUPUN1234567000',
      PNG,
      { styled: true },
    );
    const sheet = wb.worksheets[0];
    expect(sheet.getRow(1).getCell(1).value).toBeNull(); // the logo's row
    expect(sheet.getCell(2, 1).value).toBe('PF ECR');
    expect(sheet.getCell(3, 1).value).toBe(
      'Establishment Code: PUPUN1234567000',
    );
    expect(sheet.getCell(5, 1).value).toBe('UAN');
    expect(sheet.getCell(5, 1).font?.bold).toBe(true);
    expect(sheet.getCell(5, 2).alignment?.wrapText).toBe(true);
    expect(sheet.getCell(6, 1).value).toBe('100123456789');
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 5 });
    // Wide enough for the long header and the 12-digit UAN.
    expect(sheet.getColumn(1).width).toBeGreaterThanOrEqual(14);
    expect(sheet.getColumn(2).width).toBeGreaterThanOrEqual(29);
  });

  it('without a logo the title is on row 1; a CSV workbook is just the table', () => {
    const styled = buildWorkbook('PF ECR', columns, rows, undefined, null, {
      styled: true,
    }).worksheets[0];
    expect(styled.getCell(1, 1).value).toBe('PF ECR');
    expect(styled.getCell(3, 1).value).toBe('UAN');
    const csv = buildWorkbook('PF ECR', columns, rows).worksheets[0];
    expect(csv.getCell(1, 1).value).toBe('UAN');
    expect(csv.getCell(2, 1).value).toBe('100123456789');
  });
});
