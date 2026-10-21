import {
  negativeBalanceRuleFor,
  splitForLossOfPay,
} from './negative-leave-balance';

const on = (mode: 'MARK_AS_LOP' | 'UNLIMITED' | 'UP_TO_YEAR_END') => ({
  allowNegativeLeaveBalance: true,
  negativeLeaveBalanceMode: mode,
});
const off = {
  allowNegativeLeaveBalance: false,
  negativeLeaveBalanceMode: 'UNLIMITED' as const,
};

describe('negativeBalanceRuleFor', () => {
  it('never allows a negative balance while the switch is off, whatever the mode', () => {
    expect(
      negativeBalanceRuleFor(off, {}, { credited: 12, year: 2026 }),
    ).toEqual({
      allowed: false,
      maxNegativeDays: 0,
    });
  });

  it('Mark as Loss of Pay does not let the balance go negative (the request is cut instead)', () => {
    expect(
      negativeBalanceRuleFor(
        on('MARK_AS_LOP'),
        {},
        { credited: 12, year: 2026 },
      ).allowed,
    ).toBe(false);
  });

  it('Without any limit has no limit', () => {
    const rule = negativeBalanceRuleFor(
      on('UNLIMITED'),
      {},
      { credited: 12, year: 2026 },
    );
    expect(rule.allowed).toBe(true);
    expect(rule.maxNegativeDays).toBeGreaterThan(1_000_000);
  });

  it('Up to year-end allows what a periodic type will still credit, and nothing for an upfront type', () => {
    const periodic = { accrualMode: 'PERIODIC', annualQuota: 12 };
    // A periodic type that only became periodic in 2027 was granted upfront in 2026: nothing left to credit.
    const laterPeriodic = { ...periodic, periodicFromYear: 2027 };
    expect(
      negativeBalanceRuleFor(on('UP_TO_YEAR_END'), periodic, {
        credited: 5,
        year: 2026,
      }),
    ).toEqual({ allowed: true, maxNegativeDays: 7 });
    expect(
      negativeBalanceRuleFor(on('UP_TO_YEAR_END'), periodic, {
        credited: 12,
        year: 2026,
      }).allowed,
    ).toBe(false);
    expect(
      negativeBalanceRuleFor(on('UP_TO_YEAR_END'), laterPeriodic, {
        credited: 6,
        year: 2026,
      }),
    ).toEqual({ allowed: false, maxNegativeDays: 0 });
    expect(
      negativeBalanceRuleFor(
        on('UP_TO_YEAR_END'),
        { accrualMode: 'UPFRONT', annualQuota: 12 },
        { credited: 12, year: 2026 },
      ),
    ).toEqual({ allowed: false, maxNegativeDays: 0 });
  });
});

describe('splitForLossOfPay', () => {
  // Mon 2026-10-05 .. Fri 2026-10-09, then Sat/Sun, then Mon 12 .. Fri 16. Sunday is the weekly off; Saturday works.
  const weeklyOffs = [0];
  const base = {
    isHalfDay: false,
    calendarDays: false,
    holidayDates: new Set<string>(),
    weeklyOffs,
  };

  it('nothing is cut when the balance covers the request', () => {
    const r = splitForLossOfPay({
      ...base,
      startDate: '2026-10-05',
      endDate: '2026-10-07',
      totalDays: 3,
      available: 5,
    });
    expect(r).toEqual({
      coveredEnd: '2026-10-07',
      coveredDays: 3,
      lopStart: null,
      lopDays: 0,
    });
  });

  it('the balance covers the first days and the rest is Loss of Pay', () => {
    const r = splitForLossOfPay({
      ...base,
      startDate: '2026-10-05',
      endDate: '2026-10-09',
      totalDays: 5,
      available: 3,
    });
    expect(r.coveredEnd).toBe('2026-10-07');
    expect(r.coveredDays).toBe(3);
    expect(r.lopStart).toBe('2026-10-08');
    expect(r.lopDays).toBe(2);
  });

  it('a weekly off after the covered run costs nothing, so Loss of Pay starts on the next charged date', () => {
    // Thu 8 .. Tue 13, working days Thu, Fri, Sat, Mon, Tue = 5; 3 available covers Thu, Fri, Sat (and the Sunday).
    const r = splitForLossOfPay({
      ...base,
      startDate: '2026-10-08',
      endDate: '2026-10-13',
      totalDays: 5,
      available: 3,
    });
    expect(r.coveredEnd).toBe('2026-10-11');
    expect(r.coveredDays).toBe(3);
    expect(r.lopStart).toBe('2026-10-12');
    expect(r.lopDays).toBe(2);
  });

  it('a fractional balance covers only the whole days', () => {
    const r = splitForLossOfPay({
      ...base,
      startDate: '2026-10-05',
      endDate: '2026-10-09',
      totalDays: 5,
      available: 2.5,
    });
    expect(r.coveredDays).toBe(2);
    expect(r.lopDays).toBe(3);
  });

  it('with no balance the whole request is Loss of Pay', () => {
    const r = splitForLossOfPay({
      ...base,
      startDate: '2026-10-05',
      endDate: '2026-10-09',
      totalDays: 5,
      available: 0,
    });
    expect(r).toEqual({
      coveredEnd: null,
      coveredDays: 0,
      lopStart: '2026-10-05',
      lopDays: 5,
    });
  });

  it('a half day is covered only if at least half a day is available', () => {
    const half = {
      ...base,
      startDate: '2026-10-05',
      endDate: '2026-10-05',
      isHalfDay: true,
      totalDays: 0.5,
    };
    expect(splitForLossOfPay({ ...half, available: 0.5 }).lopDays).toBe(0);
    const short = splitForLossOfPay({ ...half, available: 0.25 });
    expect(short.coveredEnd).toBeNull();
    expect(short.lopDays).toBe(0.5);
  });

  it('a calendar-day type charges every date, weekends included', () => {
    const r = splitForLossOfPay({
      ...base,
      calendarDays: true,
      startDate: '2026-10-09',
      endDate: '2026-10-13',
      totalDays: 5,
      available: 3,
    });
    expect(r.coveredEnd).toBe('2026-10-11');
    expect(r.lopStart).toBe('2026-10-12');
    expect(r.lopDays).toBe(2);
  });
});
