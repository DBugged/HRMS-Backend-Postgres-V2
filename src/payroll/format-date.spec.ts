import { formatDateDisplay, formatDateTimeDisplay } from './format-date';

describe('formatDateDisplay', () => {
  it('formats a YYYY-MM-DD string as DD-MM-YYYY without a UTC shift', () => {
    expect(formatDateDisplay('2026-01-05')).toBe('05-01-2026');
  });

  it('formats a Date object', () => {
    expect(formatDateDisplay(new Date(2026, 3, 9))).toBe('09-04-2026');
  });

  it('returns the fallback for null/undefined/invalid input', () => {
    expect(formatDateDisplay(null)).toBe('');
    expect(formatDateDisplay(undefined, '-')).toBe('-');
    expect(formatDateDisplay('not-a-date', '-')).toBe('-');
  });
});

describe('formatDateTimeDisplay', () => {
  it('appends a 12-hour clock time', () => {
    const d = new Date(2026, 3, 9, 14, 5);
    expect(formatDateTimeDisplay(d)).toBe('09-04-2026, 02:05 PM');
  });

  it('handles midnight and noon correctly', () => {
    expect(formatDateTimeDisplay(new Date(2026, 0, 1, 0, 0))).toBe(
      '01-01-2026, 12:00 AM',
    );
    expect(formatDateTimeDisplay(new Date(2026, 0, 1, 12, 0))).toBe(
      '01-01-2026, 12:00 PM',
    );
  });

  it('returns the fallback for invalid input', () => {
    expect(formatDateTimeDisplay(null, '-')).toBe('-');
  });
});
