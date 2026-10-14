import { calendarSpan, wfhRequestDays } from './wfh-request-days';

describe('wfhRequestDays', () => {
  // 2026-10-26 is a Monday.
  const base = {
    // Sunday is the weekly off.
    isWeeklyOff: (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0,
    holidayDates: new Set<string>(),
    leaveDates: new Set<string>(),
  };

  it('keeps every working day of a plain Mon-Wed range', () => {
    const r = wfhRequestDays({ ...base, from: '2026-10-26', to: '2026-10-28' });
    expect(r.days).toEqual(['2026-10-26', '2026-10-27', '2026-10-28']);
    expect(r.skipped).toEqual([]);
  });

  it('leaves out the weekly off, a holiday and a leave day, and says why', () => {
    const r = wfhRequestDays({
      ...base,
      from: '2026-10-30',
      to: '2026-11-03',
      holidayDates: new Set(['2026-11-02']),
      leaveDates: new Set(['2026-11-03']),
    });
    // Fri 30 kept, Sat 31 kept (only Sunday is off), Sun 1 off, Mon 2 holiday, Tue 3 leave.
    expect(r.days).toEqual(['2026-10-30', '2026-10-31']);
    expect(r.skipped).toEqual([
      { date: '2026-11-01', reason: 'WEEKLY_OFF' },
      { date: '2026-11-02', reason: 'HOLIDAY' },
      { date: '2026-11-03', reason: 'LEAVE' },
    ]);
  });

  it('is empty when the end is before the start, and a single day when they match', () => {
    expect(wfhRequestDays({ ...base, from: '2026-10-28', to: '2026-10-26' }).days).toEqual([]);
    expect(wfhRequestDays({ ...base, from: '2026-10-26', to: '2026-10-26' }).days).toEqual(['2026-10-26']);
    expect(calendarSpan('2026-10-26', '2026-10-28')).toBe(3);
    expect(calendarSpan('2026-10-28', '2026-10-26')).toBe(0);
  });
});
