import { AccrualFrequency } from '@prisma/client';
import {
  accrualSchedule,
  annualEntitlement,
  buildPeriods,
  dueCredits,
  nextCredit,
  periodMonthsOf,
  AccrualRule,
} from './leave-accrual';
import { leaveYearBounds } from './leave-year';

const APRIL = { startMonth: 4, anchorYear: 2027 };
const y2027 = leaveYearBounds(2027, APRIL); // 1 Apr 2027 - 31 Mar 2028
const ext2026 = leaveYearBounds(2026, APRIL); // 1 Jan 2026 - 31 Mar 2027 (15 months)
const CAL2026 = leaveYearBounds(2026, { startMonth: 1, anchorYear: null });

const rule = (over: Partial<AccrualRule> = {}): AccrualRule => ({
  annualQuota: 18,
  accrualFrequency: AccrualFrequency.MONTHLY,
  accrualAmountPerCycle: 0,
  accrueAt: 'END',
  prorate: true,
  ...over,
});

describe('buildPeriods', () => {
  it('monthly: 12 periods, each a calendar month, the last ending on the year end', () => {
    const p = buildPeriods(y2027, AccrualFrequency.MONTHLY);
    expect(p).toHaveLength(12);
    expect(p[0]).toMatchObject({ start: '2027-04-01', end: '2027-04-30' });
    expect(p[11]).toMatchObject({ start: '2028-03-01', end: '2028-03-31' });
  });
  it('quarterly and half-yearly', () => {
    expect(
      buildPeriods(y2027, AccrualFrequency.QUARTERLY).map((x) => x.start),
    ).toEqual(['2027-04-01', '2027-07-01', '2027-10-01', '2028-01-01']);
    const h = buildPeriods(y2027, AccrualFrequency.HALF_YEARLY);
    expect(h).toHaveLength(2);
    expect(h[0].end).toBe('2027-09-30');
    expect(h[1].end).toBe('2028-03-31');
  });
  it('the 15-month extended year: monthly gives 15, half-yearly ends with a 3-month period', () => {
    expect(buildPeriods(ext2026, AccrualFrequency.MONTHLY)).toHaveLength(15);
    const h = buildPeriods(ext2026, AccrualFrequency.HALF_YEARLY);
    expect(h.map((x) => x.months)).toEqual([6, 6, 3]);
    expect(h[2]).toMatchObject({ start: '2027-01-01', end: '2027-03-31' });
  });
  it('period lengths', () => {
    expect(periodMonthsOf(AccrualFrequency.BI_MONTHLY)).toBe(2);
    expect(periodMonthsOf(AccrualFrequency.YEARLY)).toBe(12);
  });
});

describe('accrualSchedule - full-year employee', () => {
  it('18 days a year, monthly: 1.5 a month, 18 in total', () => {
    const s = accrualSchedule(rule(), y2027, '2020-01-01');
    expect(s.every((c) => c.days === 1.5)).toBe(true);
    expect(annualEntitlement(rule(), y2027, '2020-01-01')).toBe(18);
  });
  it('quarterly 4.5, half-yearly 9', () => {
    expect(
      accrualSchedule(
        rule({ accrualFrequency: AccrualFrequency.QUARTERLY }),
        y2027,
        '2020-01-01',
      ).map((c) => c.days),
    ).toEqual([4.5, 4.5, 4.5, 4.5]);
    expect(
      accrualSchedule(
        rule({ accrualFrequency: AccrualFrequency.HALF_YEARLY }),
        y2027,
        '2020-01-01',
      ).map((c) => c.days),
    ).toEqual([9, 9]);
  });
  it('the extended 15-month year earns 15/12 of the quota: 22.5 monthly', () => {
    expect(annualEntitlement(rule(), ext2026, '2020-01-01')).toBe(22.5);
  });
  it('credits always add up to the entitlement even when a period does not divide evenly', () => {
    // 20 days / 12 months = 1.6667 a month
    const r = rule({ annualQuota: 20 });
    const s = accrualSchedule(r, y2027, '2020-01-01');
    expect(s.reduce((a, c) => a + c.days, 0)).toBeCloseTo(20, 2);
    expect(annualEntitlement(r, y2027, '2020-01-01')).toBe(20);
    expect(s[0].days).toBe(1.67);
  });
  it('an explicit amount per cycle overrides the quota: 2 a month = 24', () => {
    expect(
      annualEntitlement(
        rule({ accrualAmountPerCycle: 2 }),
        y2027,
        '2020-01-01',
      ),
    ).toBe(24);
  });
});

describe('accrualSchedule - joining mid-year (15th rule)', () => {
  it('joins 20 Jul 2027 in an April year: counted from August, 8 months x 1.5 = 12', () => {
    const s = accrualSchedule(rule(), y2027, '2027-07-20');
    expect(s.slice(0, 4).every((c) => c.days === 0)).toBe(true); // Apr-Jul
    expect(s[4].days).toBe(1.5); // August
    expect(annualEntitlement(rule(), y2027, '2027-07-20')).toBe(12);
  });
  it('joining on the 15th counts the joining month: 9 months = 13.5', () => {
    expect(annualEntitlement(rule(), y2027, '2027-07-15')).toBe(13.5);
  });
  it('quarterly: the partial first quarter is credited for the months counted', () => {
    const r = rule({ accrualFrequency: AccrualFrequency.QUARTERLY });
    // joins 20 Aug -> counted from September: 1 month of the Jul-Sep quarter = 1.5
    const s = accrualSchedule(r, y2027, '2027-08-20');
    expect(s.map((c) => c.days)).toEqual([0, 1.5, 4.5, 4.5]);
  });
  it('prorate off: counted from the start of the year', () => {
    expect(
      annualEntitlement(rule({ prorate: false }), y2027, '2027-08-20'),
    ).toBe(18);
  });
  it('joined before the year: nothing prorated', () => {
    expect(annualEntitlement(rule(), y2027, '2026-02-02')).toBe(18);
  });
});

describe('due and next credits', () => {
  it('END: the April credit is due on 30 April, not before', () => {
    const r = rule();
    expect(
      dueCredits(r, y2027, '2020-01-01', '2027-04-29', new Set()),
    ).toHaveLength(0);
    expect(
      dueCredits(r, y2027, '2020-01-01', '2027-04-30', new Set()),
    ).toHaveLength(1);
    expect(
      dueCredits(r, y2027, '2020-01-01', '2027-06-30', new Set()),
    ).toHaveLength(3);
  });
  it('START: the April credit is due on 1 April', () => {
    const r = rule({ accrueAt: 'START' });
    expect(
      dueCredits(r, y2027, '2020-01-01', '2027-04-01', new Set()),
    ).toHaveLength(1);
  });
  it('a credit already recorded is not due again (idempotent)', () => {
    const r = rule();
    const done = new Set(['2027-04-01', '2027-05-01']);
    const due = dueCredits(r, y2027, '2020-01-01', '2027-06-30', done);
    expect(due.map((c) => c.period.start)).toEqual(['2027-06-01']);
  });
  it('a server that was down catches up every missed period', () => {
    expect(
      dueCredits(rule(), y2027, '2020-01-01', '2027-09-30', new Set()),
    ).toHaveLength(6);
  });
  it('next credit: the first one not yet due', () => {
    const n = nextCredit(rule(), y2027, '2020-01-01', '2027-06-10');
    expect(n).toMatchObject({ dueOn: '2027-06-30', days: 1.5 });
    expect(nextCredit(rule(), y2027, '2020-01-01', '2028-03-31')).toBeNull();
  });
});

describe('calendar year, January start', () => {
  it('monthly credits are due month by month', () => {
    const s = accrualSchedule(rule(), CAL2026, '2020-01-01');
    expect(s).toHaveLength(12);
    expect(s[0].dueOn).toBe('2026-01-31');
    expect(s[11].dueOn).toBe('2026-12-31');
  });
});
