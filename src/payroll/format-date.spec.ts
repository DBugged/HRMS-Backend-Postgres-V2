import {
  formatDateDisplay,
  formatDateTimeDisplay,
  resolveOrgDateTimeFormat,
} from './format-date';

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

describe('formatDateDisplay with an explicit pattern', () => {
  it('formats MM-DD-YYYY', () => {
    expect(formatDateDisplay('2026-01-05', '', 'MM-DD-YYYY')).toBe(
      '01-05-2026',
    );
  });

  it('formats YYYY-MM-DD', () => {
    expect(formatDateDisplay('2026-01-05', '', 'YYYY-MM-DD')).toBe(
      '2026-01-05',
    );
  });
});

describe('formatDateTimeDisplay with an explicit pattern', () => {
  it('formats a 24-hour clock with no AM/PM suffix', () => {
    const d = new Date(2026, 3, 9, 14, 5);
    expect(formatDateTimeDisplay(d, '', 'DD-MM-YYYY', '24')).toBe(
      '09-04-2026, 14:05',
    );
  });

  it('combines a non-default date pattern with a 24-hour clock', () => {
    const d = new Date(2026, 3, 9, 9, 5);
    expect(formatDateTimeDisplay(d, '', 'YYYY-MM-DD', '24')).toBe(
      '2026-04-09, 09:05',
    );
  });
});

describe('resolveOrgDateTimeFormat', () => {
  it('falls back to DD-MM-YYYY/12-hour when the org has no policies set', async () => {
    const scopedPrisma = {
      organization: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      resolveOrgDateTimeFormat(scopedPrisma as any, 'org-1'),
    ).resolves.toEqual({ dateFormat: 'DD-MM-YYYY', timeFormat: '12' });
  });

  it('falls back per-field when policies has malformed values', async () => {
    const scopedPrisma = {
      organization: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ policies: { dateFormat: 'nonsense' } }),
      },
    };
    await expect(
      resolveOrgDateTimeFormat(scopedPrisma as any, 'org-1'),
    ).resolves.toEqual({ dateFormat: 'DD-MM-YYYY', timeFormat: '12' });
  });

  it('reads the org-configured format when valid', async () => {
    const scopedPrisma = {
      organization: {
        findFirst: jest.fn().mockResolvedValue({
          policies: { dateFormat: 'YYYY-MM-DD', timeFormat: '24' },
        }),
      },
    };
    await expect(
      resolveOrgDateTimeFormat(scopedPrisma as any, 'org-1'),
    ).resolves.toEqual({ dateFormat: 'YYYY-MM-DD', timeFormat: '24' });
  });
});
