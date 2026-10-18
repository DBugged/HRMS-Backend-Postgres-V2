import {
  DEFAULT_OVERTIME_POLICY,
  daysSince,
  isEligibleForOvertime,
  overtimeCapProblem,
  resolveOvertimePolicy,
  roundOvertimeHours,
} from './overtime-policy';

describe('overtime policy', () => {
  it("an org that never set a policy keeps today's behaviour", () => {
    expect(resolveOvertimePolicy({})).toEqual(DEFAULT_OVERTIME_POLICY);
    expect(resolveOvertimePolicy(null)).toEqual(DEFAULT_OVERTIME_POLICY);
  });

  it('rounds to the step in the chosen direction', () => {
    const p = (roundingMode: string) =>
      resolveOvertimePolicy({
        overtimePolicy: { roundingMinutes: 30, roundingMode },
      });
    expect(roundOvertimeHours(1.4, p('DOWN'))).toBe(1);
    expect(roundOvertimeHours(1.4, p('UP'))).toBe(1.5);
    expect(roundOvertimeHours(1.3, p('NEAREST'))).toBe(1.5);
    expect(roundOvertimeHours(1.2, p('NEAREST'))).toBe(1);
    expect(roundOvertimeHours(1.5, p('DOWN'))).toBe(1.5);
  });

  it('empty eligibility means everyone; otherwise type and department both must match', () => {
    const open = resolveOvertimePolicy({});
    expect(isEligibleForOvertime(open, { employeeType: 'intern' })).toBe(true);
    const p = resolveOvertimePolicy({
      overtimePolicy: {
        eligibleEmployeeTypes: ['permanent'],
        eligibleDepartmentIds: ['d1'],
      },
    });
    expect(
      isEligibleForOvertime(p, {
        employeeType: 'permanent',
        departmentId: 'd1',
      }),
    ).toBe(true);
    expect(
      isEligibleForOvertime(p, { employeeType: 'intern', departmentId: 'd1' }),
    ).toBe(false);
    expect(
      isEligibleForOvertime(p, {
        employeeType: 'permanent',
        departmentId: 'd2',
      }),
    ).toBe(false);
  });

  it('caps block or warn, and blank caps never trigger', () => {
    const none = resolveOvertimePolicy({});
    expect(overtimeCapProblem(none, 20, 0, 500)).toEqual({});
    const block = resolveOvertimePolicy({
      overtimePolicy: { maxHoursPerMonth: 10 },
    });
    expect(overtimeCapProblem(block, 3, 0, 8).block).toMatch(/per month/);
    expect(overtimeCapProblem(block, 2, 0, 8)).toEqual({});
    const warn = resolveOvertimePolicy({
      overtimePolicy: { maxHoursPerDay: 2, capMode: 'WARN' },
    });
    expect(overtimeCapProblem(warn, 3, 0, 0).warn).toMatch(/per day/);
  });

  it('counts whole days since the date', () => {
    expect(daysSince('2026-10-10', '2026-10-17')).toBe(7);
  });
});
