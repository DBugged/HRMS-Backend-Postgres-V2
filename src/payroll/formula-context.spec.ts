import type { AttendanceSummary } from './attendance-summary';
import type { OverlaidSettings } from './statutory-overlay';
import { buildBaseContext } from './formula-context';

function attendance(
  overrides: Partial<AttendanceSummary> = {},
): AttendanceSummary {
  return {
    totalDaysInMonth: 30,
    workingDays: 26,
    presentDays: 20,
    paidLeaveDays: 2,
    unpaidLeaveDays: 0,
    halfDays: 0,
    overtimeHours: 5,
    lateMarks: 1,
    holidayWorkDays: 0,
    weekendWorkDays: 0,
    holidays: 1,
    weeklyOffs: 4,
    lopDays: 0,
    payableDays: 27,
    ...overrides,
  };
}

function settings(overrides: Partial<OverlaidSettings> = {}): OverlaidSettings {
  return {
    financialYearStartMonth: 4,
    processingDay: 0,
    paymentDay: 0,
    roundingRule: 'nearest',
    roundingDecimals: 0,
    pfEnabled: true,
    esiEnabled: false,
    ptEnabled: false,
    lwfEnabled: false,
    npsEnabled: false,
    gratuityEnabled: false,
    bonusEnabled: false,
    incomeTaxEnabled: true,
    employerInsuranceEnabled: false,
    pfEmployeeRate: 12,
    pfEmployerRate: 12,
    pfWageCeiling: 15000,
    esiEmployeeRate: 0.75,
    esiEmployerRate: 3.25,
    esiWageCeiling: 21000,
    ptSlabs: [
      { upTo: 7500, amount: 0 },
      { upTo: null, amount: 200 },
    ],
    lwfEmployeeAmount: 25,
    lwfEmployerAmount: 75,
    lwfMonths: [6, 12],
    npsEmployerRate: 10,
    gratuityRate: 4.81,
    ...overrides,
  };
}

describe('buildBaseContext', () => {
  it('maps attendance + settings fields onto the exact SYSTEM_VARS names', () => {
    const ctx = buildBaseContext(attendance(), settings(), 4);
    expect(ctx.WORKING_DAYS).toBe(26);
    expect(ctx.PAYABLE_DAYS).toBe(27);
    expect(ctx.PF_EMPLOYEE_RATE).toBe(12);
    expect(ctx.GRATUITY_RATE).toBe(4.81);
  });

  it('zeroes LWF amounts outside a configured LWF month', () => {
    const ctx = buildBaseContext(attendance(), settings(), 4);
    expect(ctx.LWF_EMPLOYEE_AMOUNT).toBe(0);
    expect(ctx.LWF_EMPLOYER_AMOUNT).toBe(0);
  });

  it('applies LWF amounts inside a configured LWF month', () => {
    const ctx = buildBaseContext(attendance(), settings(), 6);
    expect(ctx.LWF_EMPLOYEE_AMOUNT).toBe(25);
    expect(ctx.LWF_EMPLOYER_AMOUNT).toBe(75);
  });

  it('flattens ptSlabs into PT_SLAB{n}_UPTO/AMOUNT, omitting UPTO on a null (last) slab', () => {
    const ctx = buildBaseContext(attendance(), settings(), 4);
    expect(ctx.PT_SLAB1_UPTO).toBe(7500);
    expect(ctx.PT_SLAB1_AMOUNT).toBe(0);
    expect(ctx.PT_SLAB2_UPTO).toBeUndefined();
    expect(ctx.PT_SLAB2_AMOUNT).toBe(200);
  });

  it('falls back to the default 3-slab PT config when ptSlabs is empty', () => {
    const ctx = buildBaseContext(attendance(), settings({ ptSlabs: [] }), 4);
    expect(ctx.PT_SLAB1_UPTO).toBe(7500);
    expect(ctx.PT_SLAB3_AMOUNT).toBe(200);
  });
});
