import { AllocationType } from '@prisma/client';
import {
  availedBeforeExpiry,
  computeCarriedInExpiry,
  computeCarryOut,
  computeUpfrontCredit,
  firstCountedMonthIndex,
  forfeitedCarryIn,
  isCarriedInExpired,
  recalcClosing,
  shouldProrateOnJoining,
} from './leave-balance-math';

describe('computeUpfrontCredit', () => {
  it('legacy EARNED_MONTHLY is credited upfront like Fixed Annual', () => {
    const type = {
      allocationType: AllocationType.EARNED_MONTHLY,
      annualQuota: 12,
      prorateOnJoining: true,
    };
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2020, 0, 1)), 2026),
    ).toBe(12);
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

  it('a mid-year joiner sees the prorated share as the total: quota 12, joined 10 Jul = 6, joined 20 Jul = 5', () => {
    const type = {
      allocationType: AllocationType.FIXED_ANNUAL,
      annualQuota: 12,
      prorateOnJoining: true,
    };
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2026, 6, 10)), 2026),
    ).toBe(6);
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2026, 6, 20)), 2026),
    ).toBe(5);
    // someone who joined in an earlier year gets the whole quota
    expect(
      computeUpfrontCredit(type, new Date(Date.UTC(2025, 6, 20)), 2026),
    ).toBe(12);
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

describe('joining-date proration (the 15th rule)', () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const asOf = d('2026-10-05');

  it('the 15th still counts the joining month; the 16th starts counting from the next month', () => {
    expect(firstCountedMonthIndex(d('2026-02-15'))).toBe(1);
    expect(firstCountedMonthIndex(d('2026-02-16'))).toBe(2);
    expect(firstCountedMonthIndex(d('2026-12-20'))).toBe(12);
  });

  it('matches the example: quota 6, joined 7 Feb = 5.5, joined 5 Aug = 2.5, joined 20 Aug = 2', () => {
    const type = {
      allocationType: AllocationType.FIXED_ANNUAL,
      annualQuota: 6,
      prorateOnJoining: true,
    };
    const credit = (m: number, d: number) =>
      computeUpfrontCredit(type, new Date(Date.UTC(2026, m, d)), 2026);
    expect(credit(1, 7)).toBe(5.5);
    expect(credit(7, 5)).toBe(2.5);
    expect(credit(7, 20)).toBe(2);
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
