import { sanitizeSpreadsheetValue } from './report-export';

describe('sanitizeSpreadsheetValue', () => {
  it('guards text that a spreadsheet would run as a formula', () => {
    expect(sanitizeSpreadsheetValue('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(sanitizeSpreadsheetValue('@cmd')).toBe("'@cmd");
    expect(sanitizeSpreadsheetValue('+cmd|calc')).toBe("'+cmd|calc");
    expect(sanitizeSpreadsheetValue('-2+3')).toBe("'-2+3");
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
