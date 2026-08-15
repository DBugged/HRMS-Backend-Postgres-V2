// Non-mutating preview of the *next* formatted document number, ported
// from the old system's documentNumbering.js. Placeholders: {YYYY} (4-digit
// year), {YYYYMM} (year+month), {0000}/{0001}/... (zero-padded counter+1,
// padding width taken from the placeholder's own digit count). Only preview
// is ported — actually issuing+consuming a number isn't wired into any
// backend-v2 document generator yet (payslip numbering doesn't use this),
// same documented simplification as employeeIdPrefix/Counter staying a
// separate, simpler mechanism from this JSON blob.
export interface DocumentNumberingEntry {
  label: string;
  format: string;
  resetRule: 'never' | 'monthly' | 'yearly';
  counter: number;
  lastPeriodKey: string | null;
}

function currentPeriodKey(
  resetRule: DocumentNumberingEntry['resetRule'],
): string | null {
  const now = new Date();
  if (resetRule === 'monthly') {
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  if (resetRule === 'yearly') {
    return String(now.getFullYear());
  }
  return null;
}

export function previewDocumentNumber(entry: DocumentNumberingEntry): string {
  const periodKey = currentPeriodKey(entry.resetRule);
  const nextCounter =
    entry.resetRule !== 'never' && periodKey !== entry.lastPeriodKey
      ? 1
      : entry.counter + 1;

  const now = new Date();
  return entry.format
    .replace(
      '{YYYYMM}',
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`,
    )
    .replace('{YYYY}', String(now.getFullYear()))
    .replace(/\{(\d+)\}/, (_match, digits: string) =>
      String(nextCounter).padStart(digits.length, '0'),
    );
}
