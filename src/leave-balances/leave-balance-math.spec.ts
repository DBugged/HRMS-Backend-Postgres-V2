import { AccrualFrequency, AllocationType } from '@prisma/client';
import {
  accrualCyclesDue,
  accruesPerCycle,
  availedBeforeExpiry,
  computeAccrualPerCycle,
  computeAccrualPeriodKey,
  computeCarriedInExpiry,
  computeCarryOut,
  computeUpfrontCredit,
  countElapsedCycles,
  cyclesSinceJoining,
  expectedAccrualToDate,
  firstCountedMonthIndex,
  forfeitedCarryIn,
  isCarriedInExpired,
  joiningCycleFraction,
  recalcClosing,
  shouldProrateOnJoining,
} from './leave-balance-math';

describe('computeUpfrontCredit', () => {
  it('EARNED_MONTHLY always starts at 0, regardless of joining year', () => {
    const type = {
      allocationType: AllocationType.EARNED_MONTHLY,
      annualQuota: 12,
      prorateOnJoining: true,
    };
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2026, 0, 1)), 2026),
    ).toBe(0);
  });

  it('UNLIMITED/NONE credit nothing upfront', () => {
    for (const allocationType of [
      AllocationType.UNLIMITED,
      AllocationType.NONE,
    ]) {
      const type = { allocationType, annualQuota: 24, prorateOnJoining: true };
      expect(
        computeUpfrontCredit(type, new Date(Date.UTC(2020, 0, 1)), 2026),
      ).toBe(0);
    }
  });

  it('FIXED_ANNUAL grants the full quota when the employee did not join this balance year', () => {
    const type = {
      allocationType: AllocationType.FIXED_ANNUAL,
      annualQuota: 24,
      prorateOnJoining: true,
    };
    // joined 2020, balance year 2026 -> not the joining year, no proration
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2020, 5, 1)), 2026),
    ).toBe(24);
  });

  it('FIXED_ANNUAL prorates when the employee joined in the balance year and prorateOnJoining is true', () => {
    const type = {
      allocationType: AllocationType.FIXED_ANNUAL,
      annualQuota: 24,
      prorateOnJoining: true,
    };
    // Joined March (month 3) 2026 -> remainingMonths = 13 - 3 = 10
    // credited = round(24 * 10/12 * 100)/100 = 20
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2026, 2, 1)), 2026),
    ).toBe(20);
  });

  it('FIXED_ANNUAL does not prorate when prorateOnJoining is false, even in the joining year', () => {
    const type = {
      allocationType: AllocationType.FIXED_ANNUAL,
      annualQuota: 24,
      prorateOnJoining: false,
    };
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2026, 5, 1)), 2026),
    ).toBe(24);
  });

  it('PRORATED_ON_JOINING always prorates in the joining year, regardless of prorateOnJoining', () => {
    const type = {
      allocationType: AllocationType.PRORATED_ON_JOINING,
      annualQuota: 12,
      prorateOnJoining: false,
    };
    // Joined December (month 12) 2026 -> remainingMonths = 1
    // credited = round(12 * 1/12 * 100)/100 = 1
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2026, 11, 1)), 2026),
    ).toBe(1);
  });

  it('the 15th rule: joined on the 15th counts that month, joined on the 16th starts from the next', () => {
    const type = {
      allocationType: AllocationType.FIXED_ANNUAL,
      annualQuota: 24,
      prorateOnJoining: true,
    };
    // March: on the 15th -> 10 months (20), on the 16th -> 9 months (18).
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2026, 2, 15)), 2026),
    ).toBe(20);
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2026, 2, 16)), 2026),
    ).toBe(18);
  });

  it('joining after the 15th of December leaves no month to credit', () => {
    const type = {
      allocationType: AllocationType.PRORATED_ON_JOINING,
      annualQuota: 12,
      prorateOnJoining: true,
    };
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2026, 11, 20)), 2026),
    ).toBe(0);
  });

  it('gives the same yearly total as a per-cycle type for the same joining date', () => {
    // Quota 6, joined 7 Feb: upfront 6 x 11/12 = 5.5 = the quarterly figure (1.0 + 3 x 1.5).
    const upfront = computeUpfrontCredit(
      {
        allocationType: AllocationType.FIXED_ANNUAL,
        annualQuota: 6,
        prorateOnJoining: true,
      },
      new Date(Date.UTC(2026, 1, 7)),
      2026,
    );
    expect(upfront).toBe(5.5);
  });

  it('joining in January credits the full annual quota via proration (13-1=12 remaining months)', () => {
    const type = {
      allocationType: AllocationType.PRORATED_ON_JOINING,
      annualQuota: 24,
      prorateOnJoining: true,
    };
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2026, 0, 1)), 2026),
    ).toBe(24);
  });
});

describe('recalcClosing', () => {
  it('opening + credited - availed - encashed + adjusted, pending excluded', () => {
    expect(
      recalcClosing({
        opening: 5,
        credited: 12,
        availed: 3,
        encashed: 1,
        adjusted: 0.5,
      }),
    ).toBe(13.5);
  });
});

describe('computeCarryOut', () => {
  it('clamps to the max carry-forward days', () => {
    expect(computeCarryOut(20, 5)).toBe(5);
  });

  it('passes through when under the cap', () => {
    expect(computeCarryOut(3, 5)).toBe(3);
  });

  it('never goes negative even if closing is negative', () => {
    expect(computeCarryOut(-4, 5)).toBe(0);
  });

  it('treats a falsy/zero maxDays as zero carry-forward', () => {
    expect(computeCarryOut(10, 0)).toBe(0);
  });
});

describe('computeCarriedInExpiry', () => {
  it('null expiryMonths means no expiry', () => {
    expect(computeCarriedInExpiry(2027, null)).toBeNull();
    expect(computeCarriedInExpiry(2027, undefined)).toBeNull();
  });

  it('adds expiryMonths to Jan 1 of the rollover year', () => {
    expect(computeCarriedInExpiry(2027, 3)).toBe('2027-04-01');
  });

  it('handles a 12-month expiry rolling into the following year', () => {
    expect(computeCarriedInExpiry(2027, 12)).toBe('2028-01-01');
  });
});

describe('countElapsedCycles', () => {
  it('returns 1 for the ordinary one-cycle-since-last-credit case, every frequency', () => {
    expect(
      countElapsedCycles(AccrualFrequency.MONTHLY, '2026-01', '2026-02'),
    ).toBe(1);
    expect(
      countElapsedCycles(AccrualFrequency.QUARTERLY, '2026-Q1', '2026-Q2'),
    ).toBe(1);
    expect(
      countElapsedCycles(AccrualFrequency.HALF_YEARLY, '2026-H1', '2026-H2'),
    ).toBe(1);
    expect(
      countElapsedCycles(AccrualFrequency.BI_MONTHLY, '2026-B1', '2026-B2'),
    ).toBe(1);
    expect(countElapsedCycles(AccrualFrequency.YEARLY, '2025', '2026')).toBe(1);
  });

  it('backfills every cycle missed across a run gap', () => {
    // Missed Feb, Mar, Apr -> 4 cycles behind by May.
    expect(
      countElapsedCycles(AccrualFrequency.MONTHLY, '2026-01', '2026-05'),
    ).toBe(4);
    // Missed Q2, Q3 -> 3 cycles behind by Q4.
    expect(
      countElapsedCycles(AccrualFrequency.QUARTERLY, '2026-Q1', '2026-Q4'),
    ).toBe(3);
  });

  it('backfills across a year boundary', () => {
    // Nov 2025 -> Feb 2026 is 3 monthly cycles.
    expect(
      countElapsedCycles(AccrualFrequency.MONTHLY, '2025-11', '2026-02'),
    ).toBe(3);
  });

  it("matches computeAccrualPeriodKey's own output shape", () => {
    const from = computeAccrualPeriodKey(
      AccrualFrequency.QUARTERLY,
      new Date(Date.UTC(2026, 0, 15)),
    );
    const to = computeAccrualPeriodKey(
      AccrualFrequency.QUARTERLY,
      new Date(Date.UTC(2026, 9, 15)),
    );
    // Q1 -> Q4 is 3 cycles.
    expect(countElapsedCycles(AccrualFrequency.QUARTERLY, from, to)).toBe(3);
  });

  it('falls back to 1 when the stored key does not match the current frequency (e.g. frequency changed)', () => {
    expect(
      countElapsedCycles(AccrualFrequency.MONTHLY, '2026-Q1', '2026-05'),
    ).toBe(1);
  });

  it('falls back to 1 for a malformed key', () => {
    expect(
      countElapsedCycles(AccrualFrequency.MONTHLY, 'garbage', '2026-05'),
    ).toBe(1);
  });

  it('never returns 0 or negative even if toKey is not after fromKey', () => {
    expect(
      countElapsedCycles(AccrualFrequency.MONTHLY, '2026-05', '2026-05'),
    ).toBe(1);
    expect(
      countElapsedCycles(AccrualFrequency.MONTHLY, '2026-05', '2026-01'),
    ).toBe(1);
  });
});

describe('cyclesSinceJoining', () => {
  it('returns 1 when joining cycle and current cycle are the same', () => {
    expect(
      cyclesSinceJoining(
        AccrualFrequency.QUARTERLY,
        new Date(Date.UTC(2026, 7, 15)), // Q3 2026
        new Date(Date.UTC(2026, 8, 2)), // still Q3 2026
      ),
    ).toBe(1);
  });

  it("backdates to the joining cycle across many elapsed cycles (Jigar's real case)", () => {
    // Joined 23 Oct 2024 (Q4 2024) -> now Q3 2026 = Q4'24, Q1'25, Q2'25,
    // Q3'25, Q4'25, Q1'26, Q2'26, Q3'26 = 8 quarters inclusive.
    expect(
      cyclesSinceJoining(
        AccrualFrequency.QUARTERLY,
        new Date(Date.UTC(2024, 9, 23)),
        new Date(Date.UTC(2026, 8, 2)),
      ),
    ).toBe(8);
  });

  it('works across monthly frequency too', () => {
    // Joined Nov 2025 -> now Feb 2026 = Nov, Dec, Jan, Feb = 4 months.
    expect(
      cyclesSinceJoining(
        AccrualFrequency.MONTHLY,
        new Date(Date.UTC(2025, 10, 1)),
        new Date(Date.UTC(2026, 1, 15)),
      ),
    ).toBe(4);
  });

  it('falls back to 1 if the employee somehow joined after "now" (bad data)', () => {
    expect(
      cyclesSinceJoining(
        AccrualFrequency.MONTHLY,
        new Date(Date.UTC(2027, 0, 1)),
        new Date(Date.UTC(2026, 0, 1)),
      ),
    ).toBe(1);
  });
});

describe('computeAccrualPerCycle', () => {
  it('splits the annual quota evenly across each frequency', () => {
    expect(computeAccrualPerCycle(6, AccrualFrequency.QUARTERLY)).toBe(1.5);
    expect(computeAccrualPerCycle(6, AccrualFrequency.MONTHLY)).toBe(0.5);
    expect(computeAccrualPerCycle(6, AccrualFrequency.BI_MONTHLY)).toBe(1);
    expect(computeAccrualPerCycle(6, AccrualFrequency.HALF_YEARLY)).toBe(3);
    expect(computeAccrualPerCycle(6, AccrualFrequency.YEARLY)).toBe(6);
    expect(computeAccrualPerCycle(15, AccrualFrequency.MONTHLY)).toBe(1.25);
  });

  it('rounds an uneven split to 2 decimals', () => {
    expect(computeAccrualPerCycle(10, AccrualFrequency.MONTHLY)).toBe(0.83);
  });
});

describe('accruesPerCycle', () => {
  it('Fixed Annual / Prorated: upfront when Yearly, per cycle otherwise', () => {
    for (const allocationType of [
      AllocationType.FIXED_ANNUAL,
      AllocationType.PRORATED_ON_JOINING,
    ]) {
      expect(
        accruesPerCycle({
          allocationType,
          accrualFrequency: AccrualFrequency.YEARLY,
        }),
      ).toBe(false);
      expect(
        accruesPerCycle({
          allocationType,
          accrualFrequency: AccrualFrequency.QUARTERLY,
        }),
      ).toBe(true);
    }
  });

  it('legacy Earned always accrues; Unlimited / None never do', () => {
    expect(
      accruesPerCycle({
        allocationType: AllocationType.EARNED_MONTHLY,
        accrualFrequency: AccrualFrequency.YEARLY,
      }),
    ).toBe(true);
    expect(accruesPerCycle({ allocationType: AllocationType.UNLIMITED })).toBe(
      false,
    );
    expect(accruesPerCycle({ allocationType: AllocationType.NONE })).toBe(
      false,
    );
  });

  it('a per-cycle Fixed Annual type gets nothing upfront (no double credit)', () => {
    const quarterly = {
      allocationType: AllocationType.FIXED_ANNUAL,
      annualQuota: 6,
      prorateOnJoining: false,
      accrualFrequency: AccrualFrequency.QUARTERLY,
    };
    expect(computeUpfrontCredit(quarterly, new Date('2020-01-01'), 2026)).toBe(
      0,
    );
    expect(
      computeUpfrontCredit(
        { ...quarterly, accrualFrequency: AccrualFrequency.YEARLY },
        new Date('2020-01-01'),
        2026,
      ),
    ).toBe(6);
  });
});

describe('carried-in expiry', () => {
  it('a balance expires ON its expiry date (3 months from 1 Jan is gone on 1 Apr, usable through 31 Mar)', () => {
    expect(isCarriedInExpired('2026-04-01', '2026-03-31')).toBe(false);
    expect(isCarriedInExpired('2026-04-01', '2026-04-01')).toBe(true);
    expect(isCarriedInExpired('2026-04-01', '2026-06-01')).toBe(true);
    expect(isCarriedInExpired(null, '2099-01-01')).toBe(false);
  });

  it('counts approved leave taken wholly before the expiry date', () => {
    const leaves = [
      { startDate: '2026-01-12', endDate: '2026-01-16', totalDays: 5 },
      { startDate: '2026-02-10', endDate: '2026-02-12', totalDays: 3 },
    ];
    expect(availedBeforeExpiry(leaves, '2026-04-01')).toBe(8);
  });

  it('ignores leave that starts on or after the expiry date', () => {
    expect(
      availedBeforeExpiry(
        [{ startDate: '2026-04-01', endDate: '2026-04-03', totalDays: 3 }],
        '2026-04-01',
      ),
    ).toBe(0);
  });

  it('counts only the share of a straddling leave that falls before the expiry', () => {
    // 30 Mar - 2 Apr is 4 calendar days, 2 of them (30, 31 Mar) before 1 Apr.
    expect(
      availedBeforeExpiry(
        [{ startDate: '2026-03-30', endDate: '2026-04-02', totalDays: 4 }],
        '2026-04-01',
      ),
    ).toBe(2);
  });

  it('forfeits only the carried-in days that went unused', () => {
    expect(forfeitedCarryIn(10, 8, true)).toBe(2);
    expect(forfeitedCarryIn(10, 0, true)).toBe(10);
  });

  it('forfeits nothing when leave used all of it, or before it expires, or when nothing was carried in', () => {
    expect(forfeitedCarryIn(10, 12, true)).toBe(0);
    expect(forfeitedCarryIn(10, 0, false)).toBe(0);
    expect(forfeitedCarryIn(0, 0, true)).toBe(0);
  });
});

describe('expectedAccrualToDate', () => {
  const quarterly = {
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 6,
    accrualFrequency: AccrualFrequency.QUARTERLY,
    accrualAmountPerCycle: 1.5,
    prorateOnJoining: true,
  };
  it('a long-serving employee has a full year of quarters due, not a part-year from their joining month', () => {
    expect(
      expectedAccrualToDate(
        quarterly,
        new Date('2020-02-07T00:00:00Z'),
        2026,
        new Date('2026-10-05T00:00:00Z'),
      ),
    ).toBe(6);
  });
  it('prorates the joining cycle for someone who joined this year (Aug: 2 of Q3 months, then a full Q4)', () => {
    expect(
      expectedAccrualToDate(
        quarterly,
        new Date('2026-08-01T00:00:00Z'),
        2026,
        new Date('2026-10-05T00:00:00Z'),
      ),
    ).toBe(2.5);
  });
  it('gives the whole joining cycle when the type does not prorate', () => {
    expect(
      expectedAccrualToDate(
        { ...quarterly, prorateOnJoining: false },
        new Date('2026-08-01T00:00:00Z'),
        2026,
        new Date('2026-10-05T00:00:00Z'),
      ),
    ).toBe(3);
  });
  it('is 0 before the joining date', () => {
    expect(
      expectedAccrualToDate(
        quarterly,
        new Date('2026-12-01T00:00:00Z'),
        2026,
        new Date('2026-10-05T00:00:00Z'),
      ),
    ).toBe(0);
  });
});

describe('joining-date proration (the 15th rule)', () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const asOf = d('2026-10-05');

  it('the 15th still counts the joining month; the 16th starts counting from the next month', () => {
    expect(firstCountedMonthIndex(d('2026-02-15'))).toBe(1);
    expect(firstCountedMonthIndex(d('2026-02-16'))).toBe(2);
    expect(firstCountedMonthIndex(d('2026-12-20'))).toBe(12);
  });

  it('splits a quarterly joining cycle by the months that count', () => {
    expect(
      joiningCycleFraction(AccrualFrequency.QUARTERLY, d('2026-01-01')),
    ).toBe(1);
    expect(
      joiningCycleFraction(AccrualFrequency.QUARTERLY, d('2026-02-07')),
    ).toBeCloseTo(2 / 3);
    expect(
      joiningCycleFraction(AccrualFrequency.QUARTERLY, d('2026-02-20')),
    ).toBeCloseTo(1 / 3);
    expect(
      joiningCycleFraction(AccrualFrequency.QUARTERLY, d('2026-03-20')),
    ).toBe(0);
  });

  it('splits a half-yearly and a bi-monthly joining cycle', () => {
    const fraction = (f: AccrualFrequency, iso: string) =>
      joiningCycleFraction(f, d(iso));
    expect(fraction(AccrualFrequency.HALF_YEARLY, '2026-07-01')).toBe(1);
    expect(fraction(AccrualFrequency.HALF_YEARLY, '2026-09-10')).toBeCloseTo(
      4 / 6,
    );
    expect(fraction(AccrualFrequency.BI_MONTHLY, '2026-03-10')).toBe(1); // first month of Mar-Apr
    expect(fraction(AccrualFrequency.BI_MONTHLY, '2026-04-10')).toBe(1 / 2);
    expect(fraction(AccrualFrequency.BI_MONTHLY, '2026-04-25')).toBe(0);
  });

  it('a monthly cycle is all or nothing: joining after the 15th earns nothing for that month', () => {
    expect(
      joiningCycleFraction(AccrualFrequency.MONTHLY, d('2026-08-10')),
    ).toBe(1);
    expect(
      joiningCycleFraction(AccrualFrequency.MONTHLY, d('2026-08-20')),
    ).toBe(0);
    expect(
      accrualCyclesDue(
        AccrualFrequency.MONTHLY,
        d('2026-08-10'),
        2026,
        asOf,
        true,
      ),
    ).toBe(3); // Aug, Sep, Oct
    expect(
      accrualCyclesDue(
        AccrualFrequency.MONTHLY,
        d('2026-08-20'),
        2026,
        asOf,
        true,
      ),
    ).toBe(2); // Sep, Oct
  });

  it('only the joining cycle is prorated: every later cycle counts in full', () => {
    // Quarterly, joined 7 Feb 2026, asked for in Oct: Q1 (2/3) + Q2 + Q3 + Q4 = 3 2/3.
    expect(
      accrualCyclesDue(
        AccrualFrequency.QUARTERLY,
        d('2026-02-07'),
        2026,
        asOf,
        true,
      ),
    ).toBeCloseTo(11 / 3);
    expect(
      accrualCyclesDue(
        AccrualFrequency.QUARTERLY,
        d('2026-08-20'),
        2026,
        asOf,
        true,
      ),
    ).toBeCloseTo(1 + 1 / 3);
  });

  it('does nothing when the type does not prorate, or the employee joined in an earlier year', () => {
    expect(
      accrualCyclesDue(
        AccrualFrequency.QUARTERLY,
        d('2026-08-20'),
        2026,
        asOf,
        false,
      ),
    ).toBe(2);
    expect(
      accrualCyclesDue(
        AccrualFrequency.QUARTERLY,
        d('2020-02-20'),
        2026,
        asOf,
        true,
      ),
    ).toBe(4);
  });

  it('matches the example: quota 6 quarterly, joined 7 Feb = 5.5, joined 5 Aug = 2.5, joined 20 Aug = 2', () => {
    const quarterly = {
      allocationType: AllocationType.FIXED_ANNUAL,
      annualQuota: 6,
      accrualFrequency: AccrualFrequency.QUARTERLY,
      accrualAmountPerCycle: 1.5,
      prorateOnJoining: true,
    };
    expect(expectedAccrualToDate(quarterly, d('2026-02-07'), 2026, asOf)).toBe(
      5.5,
    );
    expect(expectedAccrualToDate(quarterly, d('2026-08-05'), 2026, asOf)).toBe(
      2.5,
    );
    expect(expectedAccrualToDate(quarterly, d('2026-08-20'), 2026, asOf)).toBe(
      2,
    );
  });

  it('shouldProrateOnJoining: the checkbox, or the Prorated on Joining allocation type', () => {
    expect(
      shouldProrateOnJoining({
        allocationType: AllocationType.FIXED_ANNUAL,
        prorateOnJoining: true,
      }),
    ).toBe(true);
    expect(
      shouldProrateOnJoining({
        allocationType: AllocationType.FIXED_ANNUAL,
        prorateOnJoining: false,
      }),
    ).toBe(false);
    expect(
      shouldProrateOnJoining({
        allocationType: AllocationType.PRORATED_ON_JOINING,
        prorateOnJoining: false,
      }),
    ).toBe(true);
  });
});
