import { isEligible, monthsOfService } from './leave-eligibility';

describe('monthsOfService', () => {
  it('is 0 the day someone joins', () => {
    const joined = new Date(Date.UTC(2026, 0, 15));
    expect(monthsOfService(joined, joined)).toBe(0);
  });

  it('counts whole elapsed months', () => {
    const joined = new Date(Date.UTC(2025, 0, 15)); // Jan 15 2025
    const asOf = new Date(Date.UTC(2026, 2, 15)); // Mar 15 2026 -> 14 months
    expect(monthsOfService(joined, asOf)).toBe(14);
  });

  it('does not count a partial month before the anniversary day', () => {
    const joined = new Date(Date.UTC(2025, 0, 20)); // Jan 20 2025
    const asOf = new Date(Date.UTC(2025, 2, 15)); // Mar 15 2025 -> not yet 2 months
    expect(monthsOfService(joined, asOf)).toBe(1);
  });

  it('never returns negative (joining in the future relative to asOf)', () => {
    const joined = new Date(Date.UTC(2027, 0, 1));
    const asOf = new Date(Date.UTC(2026, 0, 1));
    expect(monthsOfService(joined, asOf)).toBe(0);
  });
});

describe('isEligible', () => {
  const asOf = new Date(Date.UTC(2026, 5, 1));
  const baseType = {
    applicableDepartments: [] as string[],
    applicableEmployeeTypes: [] as string[],
    minServiceMonths: 0,
    maxServiceMonths: null as number | null,
  };
  const baseEmployee = {
    departmentId: 'dept-eng',
    employeeType: 'permanent',
    joiningDate: new Date(Date.UTC(2020, 0, 1)),
  };

  it('empty applicableDepartments/applicableEmployeeTypes means "applies to all"', () => {
    expect(isEligible(baseType, baseEmployee, asOf)).toBe(true);
  });

  it('non-empty applicableDepartments restricts to listed departments', () => {
    const type = { ...baseType, applicableDepartments: ['dept-sales'] };
    expect(isEligible(type, baseEmployee, asOf)).toBe(false);
    expect(
      isEligible(
        { ...baseType, applicableDepartments: ['dept-eng'] },
        baseEmployee,
        asOf,
      ),
    ).toBe(true);
  });

  it('an employee with no department fails a department-restricted type', () => {
    const type = { ...baseType, applicableDepartments: ['dept-eng'] };
    expect(
      isEligible(type, { ...baseEmployee, departmentId: null }, asOf),
    ).toBe(false);
  });

  it('non-empty applicableEmployeeTypes restricts to listed employee types', () => {
    const type = { ...baseType, applicableEmployeeTypes: ['contract'] };
    expect(isEligible(type, baseEmployee, asOf)).toBe(false);
  });

  it('enforces minServiceMonths', () => {
    const type = { ...baseType, minServiceMonths: 100 };
    expect(isEligible(type, baseEmployee, asOf)).toBe(false);
  });

  it('enforces maxServiceMonths when set', () => {
    const type = { ...baseType, maxServiceMonths: 1 };
    expect(isEligible(type, baseEmployee, asOf)).toBe(false);
  });

  it('maxServiceMonths null means unbounded', () => {
    const type = { ...baseType, maxServiceMonths: null };
    expect(isEligible(type, baseEmployee, asOf)).toBe(true);
  });

  it('ignores malformed (non-array) applicability fields as "applies to all"', () => {
    const type = {
      ...baseType,
      applicableDepartments: null as unknown as string[],
    };
    expect(isEligible(type, baseEmployee, asOf)).toBe(true);
  });
});
