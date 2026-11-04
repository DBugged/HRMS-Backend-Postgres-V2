import { BadRequestException } from '@nestjs/common';
import {
  applyRuleSetPolicy,
  applyRuleSetRates,
  pickRuleSet,
  sanitizeRuleSetPolicy,
  sanitizeRuleSetRates,
  type RuleSetRow,
} from './overtime-rule-sets';
import { DEFAULT_OVERTIME_POLICY } from './overtime-policy';

const set = (o: Partial<RuleSetRow>): RuleSetRow => ({
  id: 's',
  name: 'S',
  policy: {},
  rates: null,
  employeeIds: [],
  departmentIds: [],
  employeeTypes: [],
  effectiveFrom: '2026-01-01',
  isActive: true,
  ...o,
});

describe('overtime rule sets', () => {
  const person = { id: 'e1', departmentId: 'd1', employeeType: 'permanent' };
  it('person beats department beats employee type', () => {
    const byType = set({ id: 't', employeeTypes: ['permanent'] });
    const byDept = set({ id: 'd', departmentIds: ['d1'] });
    const byPerson = set({ id: 'p', employeeIds: ['e1'] });
    expect(
      pickRuleSet([byType, byDept, byPerson], person, '2026-06-01')?.id,
    ).toBe('p');
    expect(pickRuleSet([byType, byDept], person, '2026-06-01')?.id).toBe('d');
    expect(pickRuleSet([byType], person, '2026-06-01')?.id).toBe('t');
    expect(pickRuleSet([byType], { id: 'x' }, '2026-06-01')).toBeNull();
  });
  it('ignores sets not yet in effect or switched off; the latest effective date wins', () => {
    const old = set({
      id: 'old',
      departmentIds: ['d1'],
      effectiveFrom: '2026-01-01',
    });
    const newer = set({
      id: 'new',
      departmentIds: ['d1'],
      effectiveFrom: '2026-07-01',
    });
    expect(pickRuleSet([old, newer], person, '2026-06-30')?.id).toBe('old');
    expect(pickRuleSet([old, newer], person, '2026-07-01')?.id).toBe('new');
    expect(
      pickRuleSet([{ ...old, isActive: false }], person, '2026-06-30'),
    ).toBeNull();
  });
  it('a set states only what differs; the rest stays the company policy', () => {
    const merged = applyRuleSetPolicy(
      { ...DEFAULT_OVERTIME_POLICY, maxHoursPerDay: 4 },
      set({ policy: { minMinutes: 60, maxHoursPerMonth: 30 } }),
    );
    expect(merged.minMinutes).toBe(60);
    expect(merged.maxHoursPerMonth).toBe(30);
    expect(merged.maxHoursPerDay).toBe(4);
  });
  it('a set can raise a rate but never go under the legal minimum', () => {
    const base = { REGULAR: 2, WEEKEND: 2, HOLIDAY: 2, NIGHT: 2 } as never;
    const out = applyRuleSetRates(
      base,
      set({ rates: { WEEKEND: 3, REGULAR: 1.5 } }),
      2,
    ) as Record<string, number>;
    expect(out.WEEKEND).toBe(3);
    expect(out.REGULAR).toBe(2);
  });
  it('carries a minimum-hours-worked requirement from a set into the policy', () => {
    expect(DEFAULT_OVERTIME_POLICY.minWorkedHours).toBeNull();
    expect(applyRuleSetPolicy(DEFAULT_OVERTIME_POLICY, set({ policy: { minWorkedHours: 9 } })).minWorkedHours).toBe(9);
    expect(sanitizeRuleSetPolicy({ minWorkedHours: 9 })).toEqual({ minWorkedHours: 9 });
    expect(() => sanitizeRuleSetPolicy({ minWorkedHours: 30 })).toThrow(BadRequestException);
  });
  it('rejects values outside the allowed range', () => {
    expect(() => sanitizeRuleSetPolicy({ minMinutes: 999 })).toThrow(
      BadRequestException,
    );
    expect(() => sanitizeRuleSetPolicy({ capMode: 'NOPE' })).toThrow(
      BadRequestException,
    );
    expect(() => sanitizeRuleSetRates({ REGULAR: 1.5 }, 2)).toThrow(
      BadRequestException,
    );
    expect(sanitizeRuleSetPolicy({ minMinutes: 15, junk: 1 })).toEqual({
      minMinutes: 15,
    });
    expect(sanitizeRuleSetRates({}, 2)).toBeNull();
  });
});
