import type { AttendanceSummary } from './attendance-summary';
import type { OverlaidSettings } from './statutory-overlay';
import {
  buildBaseContext,
  deriveStatutoryContext,
  resolvePtSlabs,
} from './formula-context';
import { evaluateFormula } from '../salary-components/formula-engine';

// The default PT formula seeded before PT_SLAB_AMOUNT existed. Orgs created
// back then still have this exact string on their PT component.
const LEGACY_PT_FORMULA =
  'IF(GROSS_EARNINGS <= PT_SLAB1_UPTO, PT_SLAB1_AMOUNT, IF(GROSS_EARNINGS <= PT_SLAB2_UPTO, PT_SLAB2_AMOUNT, PT_SLAB3_AMOUNT))';

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
    lwfStateRates: [],
    ptStateRates: [],
    npsEmployerRate: 10,
    gratuityRate: 4.81,
    pfUseWagesRule: false,
    gratuityUseWagesRule: false,
    pfEdliRate: 0.5,
    pfAdminRate: 0.5,
    bonusRate: 8.33,
    bonusEligibilityCeiling: 21000,
    bonusCalcCeiling: 7000,
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

  it('flattens ptSlabs into PT_SLAB{n}_UPTO/AMOUNT, giving the open-ended last slab a numeric ceiling', () => {
    const ctx = buildBaseContext(attendance(), settings(), 4);
    expect(ctx.PT_SLAB1_UPTO).toBe(7500);
    expect(ctx.PT_SLAB1_AMOUNT).toBe(0);
    expect(ctx.PT_SLAB2_UPTO).toBe(Number.MAX_SAFE_INTEGER);
    expect(ctx.PT_SLAB2_AMOUNT).toBe(200);
  });

  // Regression: an org with fewer than three slabs used to leave
  // PT_SLAB3_AMOUNT undefined, so the seeded PT formula threw
  // 'Unknown reference "PT_SLAB3_AMOUNT"' and every affected employee landed
  // in the run's failures[].
  it('pads a short slab list up to the legacy three the old default formula expects', () => {
    const ctx = buildBaseContext(attendance(), settings(), 4);
    expect(ctx.PT_SLAB3_UPTO).toBe(Number.MAX_SAFE_INTEGER);
    expect(ctx.PT_SLAB3_AMOUNT).toBe(200); // repeats the real top slab
  });

  it('a two-slab org can still evaluate the legacy three-slab PT formula', () => {
    const ctx = buildBaseContext(attendance(), settings(), 4);
    expect(() =>
      evaluateFormula(LEGACY_PT_FORMULA, { ...ctx, GROSS_EARNINGS: 50000 }),
    ).not.toThrow();
    expect(
      evaluateFormula(LEGACY_PT_FORMULA, { ...ctx, GROSS_EARNINGS: 5000 }),
    ).toBe(0);
    expect(
      evaluateFormula(LEGACY_PT_FORMULA, { ...ctx, GROSS_EARNINGS: 50000 }),
    ).toBe(200);
  });

  it('falls back to the default 3-slab PT config when ptSlabs is empty', () => {
    const ctx = buildBaseContext(attendance(), settings({ ptSlabs: [] }), 4);
    expect(ctx.PT_SLAB1_UPTO).toBe(7500);
    expect(ctx.PT_SLAB3_AMOUNT).toBe(200);
  });
});

describe('state-wise LWF', () => {
  const stateRates = [
    {
      state: 'Karnataka',
      employeeAmount: 50,
      employerAmount: 100,
      months: [12],
    },
    {
      state: 'Maharashtra',
      employeeAmount: 25,
      employerAmount: 75,
      months: [6, 12],
    },
  ];
  const withStates = () => settings({ lwfStateRates: stateRates });

  it("uses the employee's state rate and months when the org has one for that state", () => {
    const dec = buildBaseContext(attendance(), withStates(), 12, {
      state: 'Karnataka',
    });
    expect(dec.LWF_EMPLOYEE_AMOUNT).toBe(50);
    expect(dec.LWF_EMPLOYER_AMOUNT).toBe(100);
    // Karnataka deducts only in December — June is a Maharashtra month, not a Karnataka one.
    const jun = buildBaseContext(attendance(), withStates(), 6, {
      state: 'Karnataka',
    });
    expect(jun.LWF_EMPLOYEE_AMOUNT).toBe(0);
    expect(jun.LWF_EMPLOYER_AMOUNT).toBe(0);
  });

  it('falls back to the org-wide default for an unknown or missing state', () => {
    const s = withStates();
    for (const state of [undefined, null, '', 'Kerala']) {
      const jun = buildBaseContext(attendance(), s, 6, { state });
      expect(jun.LWF_EMPLOYEE_AMOUNT).toBe(25); // default rate, default months [6, 12]
      expect(jun.LWF_EMPLOYER_AMOUNT).toBe(75);
    }
    expect(
      buildBaseContext(attendance(), s, 5, { state: 'Kerala' })
        .LWF_EMPLOYEE_AMOUNT,
    ).toBe(0);
  });

  it('behaves exactly as before when no state rates are configured', () => {
    const ctx = buildBaseContext(attendance(), settings(), 6, {
      state: 'Karnataka',
    });
    expect(ctx.LWF_EMPLOYEE_AMOUNT).toBe(25);
    expect(ctx.LWF_EMPLOYER_AMOUNT).toBe(75);
  });
});

describe('state-wise Professional Tax', () => {
  const mh = [
    { upTo: 7500, amount: 0 },
    { upTo: 10000, amount: 175 },
    { upTo: null, amount: 200, februaryAmount: 300 },
  ];
  const mhWomen = [
    { upTo: 25000, amount: 0 },
    { upTo: null, amount: 200, februaryAmount: 300 },
  ];
  const ka = [
    { upTo: 24999, amount: 0 },
    { upTo: null, amount: 200, februaryAmount: 300 },
  ];
  const s = () =>
    settings({
      ptSlabs: [{ upTo: null, amount: 100 }],
      ptStateRates: [
        { state: 'Maharashtra', slabs: mh, womenSlabs: mhWomen },
        { state: 'Karnataka', slabs: ka },
      ],
    });

  it("picks the state ladder, the women's ladder where defined, else the org default", () => {
    expect(resolvePtSlabs(s(), 5, { state: 'Maharashtra' })).toEqual(mh);
    expect(
      resolvePtSlabs(s(), 5, { state: 'Maharashtra', gender: 'FEMALE' }),
    ).toEqual(mhWomen);
    // Karnataka defines no women's ladder, so a woman there uses the state ladder.
    expect(
      resolvePtSlabs(s(), 5, { state: 'Karnataka', gender: 'FEMALE' }),
    ).toEqual(ka);
    expect(resolvePtSlabs(s(), 5, { state: 'Kerala' })).toEqual([
      { upTo: null, amount: 100 },
    ]);
    expect(resolvePtSlabs(s(), 5)).toEqual([{ upTo: null, amount: 100 }]);
  });

  it('charges February its own amount, so the year lands on the statutory cap', () => {
    const feb = resolvePtSlabs(s(), 2, { state: 'Maharashtra' });
    expect(feb[2].amount).toBe(300);
    expect(resolvePtSlabs(s(), 3, { state: 'Maharashtra' })[2].amount).toBe(
      200,
    );
    const months = Array.from(
      { length: 12 },
      (_, i) => resolvePtSlabs(s(), i + 1, { state: 'Maharashtra' })[2].amount,
    );
    expect(months.reduce((a, b) => a + b, 0)).toBe(2500); // 11 x 200 + 300
  });

  it('feeds the resolved ladder into the formula context PT_SLAB_AMOUNT reads', () => {
    const ctx = buildBaseContext(attendance(), s(), 2, {
      state: 'Maharashtra',
    });
    expect(ctx.PT_SLAB3_AMOUNT).toBe(300);
    expect(
      buildBaseContext(attendance(), s(), 2, { state: 'Kerala' })
        .PT_SLAB1_AMOUNT,
    ).toBe(100);
  });
});

describe('deriveStatutoryContext', () => {
  const ctx = { BASIC: 20000, DA: 5000, GROSS_EARNINGS: 100000 };

  it('wage bases are Basic + DA by default', () => {
    const d = deriveStatutoryContext(ctx, settings(), false);
    expect(d.BASIC_DA).toBe(25000);
    expect(d.PF_WAGES).toBe(25000);
    expect(d.GRATUITY_WAGES).toBe(25000);
  });

  it('lifts PF / gratuity wages to 50% of gross only where the module opted in', () => {
    const d = deriveStatutoryContext(
      ctx,
      settings({ pfUseWagesRule: true }),
      false,
    );
    expect(d.PF_WAGES).toBe(50000);
    expect(d.GRATUITY_WAGES).toBe(25000); // gratuity not opted in
    const both = deriveStatutoryContext(
      ctx,
      settings({ pfUseWagesRule: true, gratuityUseWagesRule: true }),
      false,
    );
    expect(both.GRATUITY_WAGES).toBe(50000);
  });

  it('never lowers wages when Basic + DA already exceeds 50% of gross', () => {
    const d = deriveStatutoryContext(
      { BASIC: 60000, DA: 0, GROSS_EARNINGS: 100000 },
      settings({ pfUseWagesRule: true }),
      false,
    );
    expect(d.PF_WAGES).toBe(60000);
  });

  it('treats a missing DA as 0', () => {
    expect(
      deriveStatutoryContext(
        { BASIC: 20000, GROSS_EARNINGS: 40000 },
        settings(),
        false,
      ).BASIC_DA,
    ).toBe(20000);
  });

  it('ESI stays applicable within the ceiling, or after coverage earlier in the same period', () => {
    const s = settings({ esiWageCeiling: 21000 });
    expect(
      deriveStatutoryContext({ GROSS_EARNINGS: 20000 }, s, false)
        .ESI_APPLICABLE,
    ).toBe(1);
    expect(
      deriveStatutoryContext({ GROSS_EARNINGS: 22000 }, s, false)
        .ESI_APPLICABLE,
    ).toBe(0);
    expect(
      deriveStatutoryContext({ GROSS_EARNINGS: 22000 }, s, true).ESI_APPLICABLE,
    ).toBe(1);
  });
});

describe("org-wide women's PT ladder", () => {
  const men = [
    { upTo: 7500, amount: 0 },
    { upTo: null, amount: 200, februaryAmount: 300 },
  ];
  const women = [
    { upTo: 25000, amount: 0 },
    { upTo: null, amount: 200, februaryAmount: 300 },
  ];
  const s = () => settings({ ptSlabs: men, ptWomenSlabs: women });

  it("uses the women's ladder for a woman and the standard one for everyone else", () => {
    expect(resolvePtSlabs(s(), 5, { gender: 'FEMALE' })).toEqual(women);
    for (const gender of [
      'MALE',
      'OTHER',
      'PREFER_NOT_TO_SAY',
      null,
      undefined,
    ]) {
      expect(resolvePtSlabs(s(), 5, { gender })).toEqual(men);
    }
    expect(resolvePtSlabs(s(), 5)).toEqual(men);
  });

  it('is ignored when the org has not set one, and applies February on it too', () => {
    expect(
      resolvePtSlabs(settings({ ptSlabs: men }), 5, { gender: 'FEMALE' }),
    ).toEqual(men);
    expect(resolvePtSlabs(s(), 2, { gender: 'FEMALE' })[1].amount).toBe(300);
  });
});
