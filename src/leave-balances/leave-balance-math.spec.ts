import { AllocationType } from '@prisma/client';
import {
  computeCarriedInExpiry,
  computeCarryOut,
  computeUpfrontCredit,
  recalcClosing,
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
