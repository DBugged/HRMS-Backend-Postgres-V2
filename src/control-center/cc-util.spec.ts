import { csvSafe, nextInvoiceNumber } from './cc-util';

describe('csvSafe', () => {
  it('defuses text that Excel would run as a formula', () => {
    expect(csvSafe('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`);
    expect(csvSafe('+1')).toBe("'+1");
    expect(csvSafe('-2+3')).toBe("'-2+3");
    expect(csvSafe('@SUM(A1)')).toBe("'@SUM(A1)");
  });
  it('leaves ordinary text, empty values and numbers alone', () => {
    expect(csvSafe('Acme Pvt Ltd')).toBe('Acme Pvt Ltd');
    expect(csvSafe(null)).toBe('');
    expect(csvSafe(-5)).toBe('-5');
  });
});

describe('nextInvoiceNumber', () => {
  const prefix = 'INV-202612-';
  it('starts at 0001 when the month has none', () => {
    expect(nextInvoiceNumber(prefix, null)).toBe('INV-202612-0001');
  });
  it('goes one past the highest used number, even when earlier ones were deleted', () => {
    expect(nextInvoiceNumber(prefix, 'INV-202612-0003')).toBe('INV-202612-0004');
  });
  it('ignores a number from another month', () => {
    expect(nextInvoiceNumber(prefix, 'INV-202611-0009')).toBe('INV-202612-0001');
  });
});
