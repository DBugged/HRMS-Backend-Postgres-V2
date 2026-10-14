import { PassThrough } from 'stream';
import {
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
    let body = Buffer.alloc(0);
    const res = {
      setHeader: () => undefined,
      send: (b: Buffer) => {
        body = b;
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
    const text = body.toString('utf8').replace(/^\uFEFF/, '');
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
