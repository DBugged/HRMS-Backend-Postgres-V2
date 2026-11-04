import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_OVERTIME_POLICY,
  inNightWindow,
  overtimeCapProblem,
  quarterRange,
  resolveOvertimePolicy,
  thresholdsFor,
} from './overtime-policy';
import { overtimeDayProblem } from './overtime-day-rules';
import {
  applyRuleSetPolicy,
  pickRuleSet,
  sanitizeRuleSetPolicy,
  type RuleSetRow,
} from './overtime-rule-sets';

const policy = (o: Record<string, unknown>) =>
  resolveOvertimePolicy({ overtimePolicy: o });
const set = (o: Partial<RuleSetRow>): RuleSetRow => ({
  id: 's',
  name: 'S',
  policy: {},
  rates: null,
  employeeIds: [],
  departmentIds: [],
  employeeTypes: [],
  designations: [],
  effectiveFrom: '2026-01-01',
  isActive: true,
  ...o,
});

describe('overtime: eligibility, day rules, quarter, night, delay', () => {
  it('everyone is eligible unless a set says otherwise', () => {
    expect(DEFAULT_OVERTIME_POLICY.eligible).toBe(true);
    expect(policy({ eligible: false }).eligible).toBe(false);
  });
  it('a designation match sits between department and employee type', () => {
    const person = {
      id: 'e',
      departmentId: 'd',
      designation: 'Manager',
      employeeType: 'permanent',
    };
    const byType = set({ id: 't', employeeTypes: ['permanent'] });
    const byDesignation = set({ id: 'g', designations: ['Manager'] });
    const byDept = set({ id: 'd', departmentIds: ['d'] });
    expect(pickRuleSet([byType, byDesignation], person, '2026-06-01')?.id).toBe(
      'g',
    );
    expect(
      pickRuleSet([byType, byDesignation, byDept], person, '2026-06-01')?.id,
    ).toBe('d');
  });
  it('day-type rules override the policy minimums for that kind of day only', () => {
    const p = policy({
      minMinutes: 30,
      minWorkedHours: 9,
      dayRules: { HOLIDAY: { minWorkedHours: null, minMinutes: 0 } },
    });
    expect(thresholdsFor(p, 'REGULAR')).toEqual({
      minMinutes: 30,
      minWorkedHours: 9,
    });
    expect(thresholdsFor(p, 'HOLIDAY')).toEqual({
      minMinutes: 0,
      minWorkedHours: 9,
    });
  });
  it('enforces the quarterly cap', () => {
    const p = policy({ maxHoursPerQuarter: 50 });
    expect(overtimeCapProblem(p, 4, 0, 0, 47).block).toMatch(/per quarter/);
    expect(overtimeCapProblem(p, 4, 0, 0, 40)).toEqual({});
  });
  it('finds the calendar quarter', () => {
    expect(quarterRange('2026-05-17')).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    });
    expect(quarterRange('2026-12-31')).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
    });
  });
  it('knows a night window that runs past midnight', () => {
    const p = policy({ nightStart: '22:00', nightEnd: '06:00' });
    expect(inNightWindow(p, '23:30')).toBe(true);
    expect(inNightWindow(p, '05:59')).toBe(true);
    expect(inNightWindow(p, '06:00')).toBe(false);
    expect(inNightWindow(p, '20:00')).toBe(false);
    expect(inNightWindow(DEFAULT_OVERTIME_POLICY, '23:00')).toBe(false);
  });
  it('a delayed start leaves the first minutes after the shift out of what can be claimed', () => {
    const base = {
      type: 'REGULAR',
      date: '2026-10-01',
      today: '2026-10-05',
      dayKind: 'WORKING',
      workedMinutes: 600,
      hours: 2,
      breakMinutes: 0,
    } as never;
    expect(overtimeDayProblem(base)).toBeNull();
    expect(
      overtimeDayProblem({
        ...(base as object),
        startAfterMinutes: 30,
      } as never),
    ).toBeNull();
    expect(
      overtimeDayProblem({
        ...(base as object),
        hours: 10,
        startAfterMinutes: 30,
      } as never),
    ).toMatch(/Only/);
  });
  it('with a delayed start, only time past the shift end less the delay can be claimed', () => {
    const base = {
      type: 'REGULAR',
      date: '2026-10-01',
      today: '2026-10-05',
      dayKind: 'WORKING',
      workedMinutes: 600,
      hours: 1,
      breakMinutes: 0,
      startAfterMinutes: 30,
    } as never;
    // Left 90 minutes past the shift end: 60 minutes are claimable.
    expect(
      overtimeDayProblem({
        ...(base as object),
        minutesPastShiftEnd: 90,
      } as never),
    ).toBeNull();
    expect(
      overtimeDayProblem({
        ...(base as object),
        minutesPastShiftEnd: 70,
      } as never),
    ).toMatch(/counts from 30 minute/);
    // Left before the shift end: nothing is claimable.
    expect(
      overtimeDayProblem({
        ...(base as object),
        minutesPastShiftEnd: -10,
      } as never),
    ).toMatch(/counts from 30 minute/);
  });
  it('a rule set can remove a company-wide cap with an explicit no-limit', () => {
    const company = policy({
      maxHoursPerDay: 4,
      maxHoursPerMonth: 40,
      maxHoursPerQuarter: 100,
      claimWithinDays: 7,
      minWorkedHours: 9,
    });
    const out = applyRuleSetPolicy(
      company,
      set({
        policy: {
          maxHoursPerDay: null,
          maxHoursPerQuarter: null,
          minWorkedHours: null,
        },
      }),
    );
    expect(out.maxHoursPerDay).toBeNull();
    expect(out.maxHoursPerQuarter).toBeNull();
    expect(out.minWorkedHours).toBeNull();
    // Keys the set does not mention keep the company value.
    expect(out.maxHoursPerMonth).toBe(40);
    expect(out.claimWithinDays).toBe(7);
    expect(sanitizeRuleSetPolicy({ maxHoursPerDay: null })).toEqual({
      maxHoursPerDay: null,
    });
  });
  it('validates the new policy keys', () => {
    expect(
      sanitizeRuleSetPolicy({
        eligible: false,
        compensationMode: 'PAY',
        approvalLevel: 'HR',
        autoApprove: 'OFF',
      }),
    ).toMatchObject({ eligible: false, approvalLevel: 'HR' });
    expect(() => sanitizeRuleSetPolicy({ compensationMode: 'BOTH' })).toThrow(
      BadRequestException,
    );
    expect(() => sanitizeRuleSetPolicy({ nightStart: '22:00' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      sanitizeRuleSetPolicy({ nightStart: '25:00', nightEnd: '06:00' }),
    ).toThrow(BadRequestException);
    expect(() => sanitizeRuleSetPolicy({ dayRules: { SUNDAY: {} } })).toThrow(
      BadRequestException,
    );
    expect(
      sanitizeRuleSetPolicy({ dayRules: { HOLIDAY: { minWorkedHours: 4 } } }),
    ).toEqual({ dayRules: { HOLIDAY: { minWorkedHours: 4 } } });
  });
});
