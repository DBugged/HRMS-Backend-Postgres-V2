import {
  dmyText,
  formatDateDisplay,
  formatDateTimeDisplay,
  resolveOrgDateTimeFormat,
  formatTimeInZone,
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

describe('the date format is fixed at DD-MM-YYYY', () => {
  it('ignores any other pattern a caller passes', () => {
    expect(formatDateDisplay('2026-01-05', '', 'MM-DD-YYYY')).toBe(
      '05-01-2026',
    );
    expect(formatDateDisplay('2026-01-05', '', 'YYYY-MM-DD')).toBe(
      '05-01-2026',
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

  it('keeps DD-MM-YYYY with a 24-hour clock whatever pattern is passed', () => {
    const d = new Date(2026, 3, 9, 9, 5);
    expect(formatDateTimeDisplay(d, '', 'YYYY-MM-DD', '24')).toBe(
      '09-04-2026, 09:05',
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
    ).resolves.toEqual({
      dateFormat: 'DD-MM-YYYY',
      timeFormat: '12',
      timeZone: 'Asia/Kolkata',
    });
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
    ).resolves.toEqual({
      dateFormat: 'DD-MM-YYYY',
      timeFormat: '12',
      timeZone: 'Asia/Kolkata',
    });
  });

  it('reads the time format but always returns DD-MM-YYYY, even for an older saved value', async () => {
    const scopedPrisma = {
      organization: {
        findFirst: jest.fn().mockResolvedValue({
          policies: { dateFormat: 'YYYY-MM-DD', timeFormat: '24' },
        }),
      },
    };
    await expect(
      resolveOrgDateTimeFormat(scopedPrisma as any, 'org-1'),
    ).resolves.toEqual({
      dateFormat: 'DD-MM-YYYY',
      timeFormat: '24',
      timeZone: 'Asia/Kolkata',
    });
  });
});

describe('formatTimeInZone', () => {
  // 04:00 UTC == 09:30 IST == 13:00 Tokyo; the SERVER zone must not matter.
  const instant = new Date('2026-05-04T04:00:00.000Z');

  it('prints the clock time in the given timezone, not the server zone', () => {
    expect(formatTimeInZone(instant, 'Asia/Kolkata', '12')).toBe('09:30 AM');
    expect(formatTimeInZone(instant, 'Asia/Kolkata', '24')).toBe('09:30');
    expect(formatTimeInZone(instant, 'Asia/Tokyo', '12')).toBe('01:00 PM');
  });

  it('handles midnight and noon in both formats', () => {
    expect(
      formatTimeInZone(
        new Date('2026-05-03T18:30:00.000Z'),
        'Asia/Kolkata',
        '12',
      ),
    ).toBe('12:00 AM');
    expect(
      formatTimeInZone(
        new Date('2026-05-03T18:30:00.000Z'),
        'Asia/Kolkata',
        '24',
      ),
    ).toBe('00:00');
    expect(
      formatTimeInZone(
        new Date('2026-05-04T06:30:00.000Z'),
        'Asia/Kolkata',
        '12',
      ),
    ).toBe('12:00 PM');
  });

  it('returns the fallback for an empty value', () => {
    expect(formatTimeInZone(null, 'Asia/Kolkata')).toBe('');
    expect(formatTimeInZone(undefined, 'Asia/Kolkata', '12', '-')).toBe('-');
  });
});

describe('timestamps are read in the organisation timezone', () => {
  // 20:30 UTC on 12 Oct is already 02:00 on 13 Oct in IST (UTC+5:30) and still 16:30 on 12 Oct in New York (UTC-4).
  const instant = new Date('2026-10-12T20:30:00.000Z');

  it('gives the same day wherever the server runs', () => {
    expect(formatDateDisplay(instant, '', 'DD-MM-YYYY', 'Asia/Kolkata')).toBe(
      '13-10-2026',
    );
    expect(formatDateDisplay(instant, '', 'DD-MM-YYYY', 'UTC')).toBe(
      '12-10-2026',
    );
    expect(
      formatDateDisplay(instant, '', 'DD-MM-YYYY', 'America/New_York'),
    ).toBe('12-10-2026');
  });

  it('reads an ISO timestamp string the same way', () => {
    expect(
      formatDateDisplay(
        '2026-10-12T20:30:00Z',
        '',
        'DD-MM-YYYY',
        'Asia/Kolkata',
      ),
    ).toBe('13-10-2026');
  });

  it('uses the same zone for the time', () => {
    expect(
      formatDateTimeDisplay(instant, '', 'DD-MM-YYYY', '24', 'Asia/Kolkata'),
    ).toBe('13-10-2026, 02:00');
    expect(
      formatDateTimeDisplay(
        instant,
        '',
        'DD-MM-YYYY',
        '12',
        'America/New_York',
      ),
    ).toBe('12-10-2026, 04:30 PM');
  });

  it('never shifts a plain calendar date or a date-only (UTC-midnight) value', () => {
    expect(
      formatDateDisplay('2026-10-12', '', 'DD-MM-YYYY', 'Pacific/Auckland'),
    ).toBe('12-10-2026');
    const joining = new Date('2026-10-12T00:00:00.000Z');
    expect(
      formatDateDisplay(joining, '', 'DD-MM-YYYY', 'America/Los_Angeles'),
    ).toBe('12-10-2026');
  });

  it('falls back to the platform zone for an unknown zone name', () => {
    expect(formatDateDisplay(instant, '', 'DD-MM-YYYY', 'Not/AZone')).toBe(
      '13-10-2026',
    );
  });

  it('returns the fallback for an impossible calendar date', () => {
    expect(formatDateDisplay('2026-02-31', 'n/a')).toBe('n/a');
  });
});

describe('dmyText (dates inside a sentence a person reads)', () => {
  it('writes a real date as DD-MM-YYYY', () => {
    expect(dmyText('2026-10-08')).toBe('08-10-2026');
    expect(dmyText('2026-01-31')).toBe('31-01-2026');
  });

  it('keeps what was typed when it is not a real date, so a message never goes blank', () => {
    expect(dmyText('2026-02-31')).toBe('2026-02-31');
    expect(dmyText('not a date')).toBe('not a date');
    expect(dmyText(null)).toBe('');
    expect(dmyText(undefined)).toBe('');
  });
});
