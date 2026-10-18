import { isScheduleDue, periodFor } from './scheduled-report-period';

describe('scheduled report period', () => {
  it('covers the period that has just ended', () => {
    expect(periodFor('DAILY', '2026-10-19')).toMatchObject({
      from: '2026-10-18',
      to: '2026-10-18',
    });
    expect(periodFor('WEEKLY', '2026-10-19')).toMatchObject({
      from: '2026-10-12',
      to: '2026-10-18',
    });
    expect(periodFor('MONTHLY', '2026-10-05')).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
      month: 9,
      year: 2026,
    });
  });

  it('rolls over a year and handles February', () => {
    expect(periodFor('MONTHLY', '2027-01-03')).toMatchObject({
      from: '2026-12-01',
      to: '2026-12-31',
      month: 12,
      year: 2026,
    });
    expect(periodFor('MONTHLY', '2028-03-02')).toMatchObject({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(periodFor('DAILY', '2026-01-01')).toMatchObject({
      from: '2025-12-31',
      to: '2025-12-31',
      month: 12,
      year: 2025,
    });
  });

  const base = {
    frequency: 'DAILY',
    dayOfWeek: null,
    dayOfMonth: null,
    sendHour: 8,
    enabled: true,
    lastRunDate: null,
  };
  const at = (hour: number, today = '2026-10-19', weekday = 1) => ({
    today,
    hour,
    weekday,
  });

  it('is due from its hour on, once a day', () => {
    expect(isScheduleDue(base, at(7))).toBe(false);
    expect(isScheduleDue(base, at(8))).toBe(true);
    // A job that was down at 08:00 still sends later the same day.
    expect(isScheduleDue(base, at(11))).toBe(true);
    expect(isScheduleDue({ ...base, lastRunDate: '2026-10-19' }, at(9))).toBe(
      false,
    );
    expect(isScheduleDue({ ...base, lastRunDate: '2026-10-18' }, at(9))).toBe(
      true,
    );
    expect(isScheduleDue({ ...base, enabled: false }, at(9))).toBe(false);
  });

  it('weekly runs on its weekday, monthly on its day of month', () => {
    const weekly = { ...base, frequency: 'WEEKLY', dayOfWeek: 1 };
    expect(isScheduleDue(weekly, at(9, '2026-10-19', 1))).toBe(true);
    expect(isScheduleDue(weekly, at(9, '2026-10-20', 2))).toBe(false);
    const monthly = { ...base, frequency: 'MONTHLY', dayOfMonth: 5 };
    expect(isScheduleDue(monthly, at(9, '2026-10-05'))).toBe(true);
    expect(isScheduleDue(monthly, at(9, '2026-10-06'))).toBe(false);
  });
});
