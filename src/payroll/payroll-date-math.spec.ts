import { PayFrequency } from '@prisma/client';
import {
  clampLeaveDaysToMonth,
  clampLeaveDaysToRange,
  daysInMonth,
  daysInRange,
  isComponentPayableThisMonth,
  lastDayOfMonth,
  round,
} from './payroll-date-math';

describe('daysInMonth', () => {
  it('returns the correct day count, including a leap February', () => {
    expect(daysInMonth(4, 2026)).toBe(30);
    expect(daysInMonth(2, 2024)).toBe(29);
    expect(daysInMonth(2, 2026)).toBe(28);
  });
});

describe('lastDayOfMonth', () => {
  it('returns YYYY-MM-DD for the last calendar day', () => {
    expect(lastDayOfMonth(4, 2026)).toBe('2026-04-30');
    expect(lastDayOfMonth(2, 2024)).toBe('2024-02-29');
  });
});

describe('isComponentPayableThisMonth', () => {
  it('MONTHLY is always payable', () => {
    expect(isComponentPayableThisMonth(PayFrequency.MONTHLY, 1, 4)).toBe(true);
  });

  it('QUARTERLY is only payable in the last month of each FY-relative quarter', () => {
    // FY starts April: quarters end June, September, December, March.
    expect(isComponentPayableThisMonth(PayFrequency.QUARTERLY, 6, 4)).toBe(
      true,
    );
    expect(isComponentPayableThisMonth(PayFrequency.QUARTERLY, 5, 4)).toBe(
      false,
    );
    expect(isComponentPayableThisMonth(PayFrequency.QUARTERLY, 3, 4)).toBe(
      true,
    );
  });

  it('YEARLY is only payable in the last month of the FY', () => {
    expect(isComponentPayableThisMonth(PayFrequency.YEARLY, 3, 4)).toBe(true);
    expect(isComponentPayableThisMonth(PayFrequency.YEARLY, 4, 4)).toBe(false);
  });

  it('HALF_YEARLY respects a non-default FY start month', () => {
    expect(isComponentPayableThisMonth(PayFrequency.HALF_YEARLY, 6, 1)).toBe(
      true,
    );
    expect(isComponentPayableThisMonth(PayFrequency.HALF_YEARLY, 12, 1)).toBe(
      true,
    );
    expect(isComponentPayableThisMonth(PayFrequency.HALF_YEARLY, 3, 1)).toBe(
      false,
    );
  });
});

describe('clampLeaveDaysToMonth', () => {
  it('a half-day leave is always 0.5', () => {
    expect(
      clampLeaveDaysToMonth(
        { isHalfDay: true, startDate: '2026-04-10', endDate: '2026-04-10' },
        4,
        2026,
      ),
    ).toBe(0.5);
  });

  it('counts inclusive days fully inside the month', () => {
    expect(
      clampLeaveDaysToMonth(
        { isHalfDay: false, startDate: '2026-04-10', endDate: '2026-04-12' },
        4,
        2026,
      ),
    ).toBe(3);
  });

  it('clamps a leave spanning into the next month', () => {
    expect(
      clampLeaveDaysToMonth(
        { isHalfDay: false, startDate: '2026-04-29', endDate: '2026-05-02' },
        4,
        2026,
      ),
    ).toBe(2); // Apr 29, 30
  });

  it('clamps a leave spanning in from the previous month', () => {
    expect(
      clampLeaveDaysToMonth(
        { isHalfDay: false, startDate: '2026-03-30', endDate: '2026-04-02' },
        4,
        2026,
      ),
    ).toBe(2); // Apr 1, 2
  });

  it('returns 0 for a leave entirely outside the month', () => {
    expect(
      clampLeaveDaysToMonth(
        { isHalfDay: false, startDate: '2026-03-01', endDate: '2026-03-05' },
        4,
        2026,
      ),
    ).toBe(0);
  });
});

describe('round', () => {
  it('nearest (default) rounds to the given decimals', () => {
    expect(round(100.456, 'nearest', 2)).toBe(100.46);
  });

  it('up always rounds toward positive infinity', () => {
    expect(round(100.001, 'up', 0)).toBe(101);
  });

  it('down always rounds toward zero decimals downward', () => {
    expect(round(100.999, 'down', 0)).toBe(100);
  });

  it('none leaves the value untouched', () => {
    expect(round(100.123456, 'none', 0)).toBe(100.123456);
  });
});

describe('clampLeaveDaysToRange / daysInRange', () => {
  const leave = (startDate: string, endDate: string, isHalfDay = false) => ({
    startDate,
    endDate,
    isHalfDay,
  });

  it('clamps a leave to an arbitrary window', () => {
    expect(
      clampLeaveDaysToRange(
        leave('2026-06-10', '2026-06-20'),
        '2026-06-16',
        '2026-06-30',
      ),
    ).toBe(5);
    expect(
      clampLeaveDaysToRange(
        leave('2026-06-10', '2026-06-12'),
        '2026-06-16',
        '2026-06-30',
      ),
    ).toBe(0);
  });

  it('a half-day counts only in the window containing it', () => {
    const half = leave('2026-06-16', '2026-06-16', true);
    expect(clampLeaveDaysToRange(half, '2026-06-01', '2026-06-15')).toBe(0);
    expect(clampLeaveDaysToRange(half, '2026-06-16', '2026-06-30')).toBe(0.5);
  });

  it('daysInRange is inclusive', () => {
    expect(daysInRange('2026-06-01', '2026-06-15')).toBe(15);
    expect(daysInRange('2026-06-16', '2026-06-16')).toBe(1);
    expect(daysInRange('2026-02-01', '2026-02-28')).toBe(28);
  });
});
