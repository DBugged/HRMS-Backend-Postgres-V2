import { TaxRegime } from '@prisma/client';
import {
  decideRegimeChange,
  regimeChangeStatus,
  type RegimeRuleContext,
} from './regime-rules';

const base: RegimeRuleContext = {
  current: TaxRegime.NEW,
  requested: TaxRegime.OLD,
  byHr: false,
  changesUsed: 0,
  payrollStarted: false,
  isCurrentYear: true,
  employeeChangeAllowed: true,
  cutoffMonth: null,
  fyStartMonth: 4,
  currentMonth: 6,
};
const decide = (over: Partial<RegimeRuleContext> = {}) =>
  decideRegimeChange({ ...base, ...over });

describe('decideRegimeChange', () => {
  it('asking for the regime already on file changes nothing and is always fine', () => {
    expect(
      decide({
        requested: TaxRegime.NEW,
        employeeChangeAllowed: false,
        changesUsed: 5,
      }),
    ).toEqual({ ok: true, usesChange: false });
  });

  describe('before the first payroll of the year', () => {
    it('choosing is free and does not use up the change', () => {
      expect(decide()).toEqual({ ok: true, usesChange: false });
    });
    it('it can be flipped back and forth any number of times', () => {
      expect(decide({ changesUsed: 0 }).ok).toBe(true);
      expect(
        decide({ current: TaxRegime.OLD, requested: TaxRegime.NEW }).ok,
      ).toBe(true);
    });
  });

  describe('once payroll has started', () => {
    const started = { payrollStarted: true };
    it('the first change is allowed and uses up the one change', () => {
      expect(decide(started)).toEqual({ ok: true, usesChange: true });
    });
    it('the second change is refused with a reason the employee can act on', () => {
      const d = decide({ ...started, changesUsed: 1 });
      expect(d.ok).toBe(false);
      expect((d as { reason: string }).reason).toMatch(/once a year.*Ask HR/);
    });
    it('works the same from Old back to New', () => {
      expect(
        decide({
          ...started,
          current: TaxRegime.OLD,
          requested: TaxRegime.NEW,
        }),
      ).toEqual({ ok: true, usesChange: true });
    });
  });

  describe('the company can switch employee changes off', () => {
    it('refuses even a free choice, and points to HR', () => {
      const d = decide({ employeeChangeAllowed: false });
      expect(d.ok).toBe(false);
      expect((d as { reason: string }).reason).toMatch(/HR/);
    });
  });

  describe('cut-off month', () => {
    it('allows a change in the cut-off month itself', () => {
      expect(
        decide({ cutoffMonth: 12, currentMonth: 12, payrollStarted: true }).ok,
      ).toBe(true);
    });
    it('refuses after it and names the month', () => {
      const d = decide({
        cutoffMonth: 12,
        currentMonth: 1,
        payrollStarted: true,
      });
      expect(d.ok).toBe(false);
      expect((d as { reason: string }).reason).toContain('December');
    });
    it('counts months from the start of the financial year, so January is after December', () => {
      expect(decide({ cutoffMonth: 12, currentMonth: 1 }).ok).toBe(false);
      expect(decide({ cutoffMonth: 1, currentMonth: 12 }).ok).toBe(true);
    });
    it('also stops a free choice before payroll once the month has passed', () => {
      expect(decide({ cutoffMonth: 6, currentMonth: 7 }).ok).toBe(false);
    });
    it('no cut-off means the whole year', () => {
      expect(
        decide({ cutoffMonth: null, currentMonth: 3, payrollStarted: true }).ok,
      ).toBe(true);
    });
  });

  describe('a past year', () => {
    it('an employee cannot change it', () => {
      expect(decide({ isCurrentYear: false }).ok).toBe(false);
    });
  });

  describe('HR and Admin', () => {
    const hr = { byHr: true };
    it('can always change it, and it never uses up the employee change', () => {
      expect(
        decide({
          ...hr,
          payrollStarted: true,
          changesUsed: 3,
          employeeChangeAllowed: false,
          cutoffMonth: 5,
          currentMonth: 11,
          isCurrentYear: false,
        }),
      ).toEqual({ ok: true, usesChange: false });
    });
  });
});

describe('regimeChangeStatus', () => {
  const { requested: _r, byHr: _b, ...ctx } = base;
  void _r;
  void _b;
  it('before payroll: can change, free', () => {
    expect(regimeChangeStatus(ctx)).toEqual({
      canChange: true,
      reason: null,
      free: true,
    });
  });
  it('after payroll with the change unused: can change, but it counts', () => {
    expect(regimeChangeStatus({ ...ctx, payrollStarted: true })).toEqual({
      canChange: true,
      reason: null,
      free: false,
    });
  });
  it('after the change is used: cannot, with a reason', () => {
    const s = regimeChangeStatus({
      ...ctx,
      payrollStarted: true,
      changesUsed: 1,
    });
    expect(s.canChange).toBe(false);
    expect(s.reason).toMatch(/already changed/);
  });
});
