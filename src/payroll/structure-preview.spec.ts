import { AttendanceStatus as S } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import {
  att,
  defaultComponents,
  defaultSettings,
  fixed,
  makeEngine,
  makeWorld,
  percent,
  type World,
} from './testing/engine-harness';
import { applyStatutoryOverrides } from './statutory-overlay';
import {
  computeStructurePreview,
  employerMonthlyForStructure,
  monthlyFiguresForStructure,
  type StructureLineToSave,
  type StructurePreviewInput,
} from './structure-preview';

const SETTINGS_ROW = defaultSettings({
  pfEnabled: true,
  esiEnabled: true,
  gratuityEnabled: true,
  bonusEnabled: true,
});
const components = () => defaultComponents() as never;
const settings = () => applyStatutoryOverrides(SETTINGS_ROW as never, {});
const preview = (input: StructurePreviewInput) =>
  computeStructurePreview({
    input,
    components: components(),
    settings: settings(),
  });

// January 2027: a full month with no Labour Welfare Fund instalment.
const fullMonth = () =>
  Array.from({ length: 31 }, (_, i) => {
    const date = `2027-01-${String(i + 1).padStart(2, '0')}`;
    return att(
      date,
      new Date(`${date}T00:00:00Z`).getUTCDay() === 0
        ? S.WEEKLY_OFF
        : S.PRESENT,
    );
  });

// What the saved structure becomes, and what the REAL payroll engine says about it.
const overrideRows = (lines: StructureLineToSave[]) =>
  lines.map((l) => {
    if (l.valueType === 'PERCENTAGE') {
      return {
        ...percent(
          l.componentCode,
          l.percentageValue ?? 0,
          l.percentageOf ?? 'BASIC',
        ),
        isEnabled: l.isEnabled,
      };
    }
    return {
      ...fixed(l.componentCode, l.fixedAmount ?? 0),
      valueType: l.valueType,
      amountBasis: l.amountBasis ?? 'MONTHLY',
      isEnabled: l.isEnabled,
    };
  });
const engine = async (lines: StructureLineToSave[]) => {
  const w: World = makeWorld({
    settings: SETTINGS_ROW,
    overrides: overrideRows(lines),
    attendance: fullMonth(),
  });
  return makeEngine(w, '2027-02-10').calc(1, 2027);
};

describe('salary structure preview', () => {
  it('metro city: Basic is half the package, HRA 50% of Basic, Special Allowance the balance', () => {
    const p = preview({
      mode: 'CTC',
      annualCtc: 600000,
      cityClass: 'METRO',
      employeeType: 'permanent',
    });
    expect(p.earnings.find((l) => l.code === 'BASIC')?.monthly).toBe(25000);
    expect(p.earnings.find((l) => l.code === 'HRA')?.monthly).toBe(12500);
    expect(p.hraPercent).toBe(50);
    expect(p.wagesPercent).toBeGreaterThanOrEqual(50);
    expect(p.grossMonthly + p.employerMonthly).toBe(p.ctcMonthly);
    expect(Math.abs(p.ctcAnnual - 600000)).toBeLessThanOrEqual(12);
    expect(p.warnings).toEqual([]);
  });

  it('other city: HRA is 40% of Basic', () => {
    const p = preview({
      mode: 'CTC',
      annualCtc: 600000,
      cityClass: 'NON_METRO',
    });
    expect(p.earnings.find((l) => l.code === 'HRA')?.monthly).toBe(10000);
    expect(p.hraPercent).toBe(40);
  });

  it('village: no HRA by default, and the saved structure switches it off', () => {
    const p = preview({ mode: 'CTC', annualCtc: 600000, cityClass: 'RURAL' });
    expect(p.earnings.find((l) => l.code === 'HRA')).toBeUndefined();
    expect(p.lines.find((l) => l.componentCode === 'HRA')).toMatchObject({
      isEnabled: false,
    });
    const withHra = preview({
      mode: 'CTC',
      annualCtc: 600000,
      cityClass: 'RURAL',
      hra: { enabled: true, percent: 30 },
    });
    expect(withHra.earnings.find((l) => l.code === 'HRA')?.monthly).toBe(
      Math.round(
        0.3 * (withHra.earnings.find((l) => l.code === 'BASIC')?.monthly ?? 0),
      ),
    );
  });

  it('an intern gets no PF, ESI, gratuity or bonus accrual, so the package is all pay', () => {
    const p = preview({
      mode: 'CTC',
      annualCtc: 240000,
      cityClass: 'NON_METRO',
      employeeType: 'intern',
    });
    expect(p.employer).toEqual([]);
    expect(p.statutory).toMatchObject({
      pf: false,
      esi: false,
      gratuity: false,
      bonus: false,
    });
    expect(p.grossMonthly).toBe(20000);
    const off = p.lines.filter((l) => !l.isEnabled).map((l) => l.componentCode);
    expect(off).toEqual(
      expect.arrayContaining([
        'PF',
        'PF_EMPLOYER',
        'ESI',
        'ESI_EMPLOYER',
        'GRATUITY_ACCRUAL',
        'BONUS_ACCRUAL',
      ]),
    );
  });

  it('a ticked scheme can be turned off for an employee type that has it', () => {
    const p = preview({
      mode: 'CTC',
      annualCtc: 600000,
      cityClass: 'METRO',
      statutory: { gratuity: false },
    });
    expect(
      p.employer.find((l) => l.code === 'GRATUITY_ACCRUAL'),
    ).toBeUndefined();
    expect(p.employer.find((l) => l.code === 'PF_EMPLOYER')).toBeDefined();
  });

  it('a monthly gross is accepted too: the package is then gross plus what the employer pays', () => {
    const p = preview({
      mode: 'GROSS',
      monthlyGross: 40000,
      cityClass: 'NON_METRO',
    });
    expect(p.grossMonthly).toBe(40000);
    expect(p.ctcMonthly).toBe(40000 + p.employerMonthly);
    expect(p.wagesPercent).toBeGreaterThanOrEqual(49.9);
  });

  it('chosen allowances keep their amount and the balance shrinks', () => {
    const p = preview({
      mode: 'CTC',
      annualCtc: 600000,
      cityClass: 'METRO',
      allowances: { CONVEYANCE: 1600, MEDICAL_ALLOWANCE: 1250 },
    });
    expect(p.earnings.find((l) => l.code === 'CONVEYANCE')?.monthly).toBe(1600);
    expect(
      p.earnings.find((l) => l.code === 'MEDICAL_ALLOWANCE')?.monthly,
    ).toBe(1250);
    const plain = preview({
      mode: 'CTC',
      annualCtc: 600000,
      cityClass: 'METRO',
    });
    expect(
      (p.earnings.find((l) => l.code === 'SPECIAL_ALLOWANCE')?.monthly ?? 0) +
        2850,
    ).toBe(plain.earnings.find((l) => l.code === 'SPECIAL_ALLOWANCE')?.monthly);
  });

  it('Basic is never under half of gross, even when the package does not split into whole rupees', () => {
    for (const annualCtc of [1100000, 1234567, 999999, 2400001]) {
      const p = preview({ mode: 'CTC', annualCtc, cityClass: 'METRO' });
      const basic = p.earnings.find((l) => l.code === 'BASIC')!.monthly;
      expect(basic * 2).toBeGreaterThanOrEqual(p.grossMonthly);
    }
  });

  describe('the package adds up exactly', () => {
    // A CTC that is not a multiple of 12 used to drift by a few rupees (12,00,000 came out as 12,00,004).
    const monthlyOf = (p: ReturnType<typeof preview>) =>
      p.lines
        .filter(
          (l) =>
            l.isEnabled &&
            l.valueType === 'FIXED' &&
            l.amountBasis === 'MONTHLY',
        )
        .reduce((sum, l) => sum + (l.fixedAmount ?? 0), 0);

    it.each([1100000, 1200000, 999999, 1234567, 2400001, 600000, 720000])(
      'CTC %s: the lines, the yearly column and the CTC all agree',
      (annualCtc) => {
        const p = preview({ mode: 'CTC', annualCtc, cityClass: 'METRO' });
        expect(p.ctcAnnual).toBe(annualCtc);
        expect(p.totalAnnual).toBe(annualCtc);
        const hra = p.lines.find((l) => l.componentCode === 'HRA')!;
        const basic = p.lines.find((l) => l.componentCode === 'BASIC')!;
        const hraAmount =
          ((basic.fixedAmount ?? 0) * (hra.percentageValue ?? 0)) / 100;
        // Saved monthly amounts: Basic and the percentage HRA, plus the rest.
        const savedMonthly = monthlyOf(p) + hraAmount;
        // CTC = the monthly pay plus what the employer pays on top (PF and the like), for twelve months.
        expect(
          Math.abs((savedMonthly + p.employerMonthly) * 12 - annualCtc),
        ).toBeLessThan(0.01);
        // The yearly column adds up to the yearly pay.
        const yearlySum = p.earnings.reduce((s, l) => s + l.annual, 0);
        expect(yearlySum).toBe(p.ctcAnnual - p.employerMonthly * 12);
      },
    );

    it('HRA is a whole-rupee amount, so only the balancing allowance is ever fractional', () => {
      for (const annualCtc of [1100000, 1234567, 999999]) {
        const p = preview({ mode: 'CTC', annualCtc, cityClass: 'NON_METRO' });
        const basic = p.lines.find(
          (l) => l.componentCode === 'BASIC',
        )!.fixedAmount!;
        const pct = p.lines.find(
          (l) => l.componentCode === 'HRA',
        )!.percentageValue!;
        expect(((basic * pct) / 100) % 1).toBeCloseTo(0, 6);
        expect(Number.isInteger(basic)).toBe(true);
      }
    });

    it('Basic is still at least half of the pay after rounding it to suit HRA', () => {
      for (const annualCtc of [1100000, 1234567, 999999, 2400001]) {
        for (const cityClass of ['METRO', 'NON_METRO'] as const) {
          const p = preview({ mode: 'CTC', annualCtc, cityClass });
          const basic = p.lines.find(
            (l) => l.componentCode === 'BASIC',
          )!.fixedAmount!;
          expect(basic * 2).toBeGreaterThanOrEqual(p.grossMonthly);
        }
      }
    });

    it('a month is paid as the nearest rupee of the package', () => {
      const p = preview({
        mode: 'CTC',
        annualCtc: 1100000,
        cityClass: 'METRO',
      });
      // Pay plus what the employer adds on top (PF and the like) is the package for the month.
      expect(Math.round(p.grossMonthly + p.employerMonthly)).toBe(
        Math.round(1100000 / 12),
      );
    });

    it('a monthly gross that is a whole number stays whole', () => {
      const p = preview({
        mode: 'GROSS',
        monthlyGross: 55000,
        cityClass: 'METRO',
      });
      expect(p.grossMonthly).toBe(55000);
      expect(p.earnings.every((l) => Number.isInteger(l.monthly))).toBe(true);
    });
  });

  it('variable pay inside the CTC is carved out of it: fixed + variable add back to the CTC', () => {
    const p = preview({
      mode: 'CTC',
      annualCtc: 600000,
      variableAnnual: 60000,
      variableIncludedInCtc: true,
      cityClass: 'METRO',
    });
    expect(p.variableAnnual).toBe(60000);
    expect(p.ctcAnnual).toBe(540000);
    expect(p.totalAnnual).toBe(600000);
  });

  it('variable pay on top of the CTC leaves the fixed CTC as entered', () => {
    const p = preview({
      mode: 'CTC',
      annualCtc: 600000,
      variableAnnual: 60000,
      variableIncludedInCtc: false,
      cityClass: 'METRO',
    });
    expect(p.ctcAnnual).toBe(600000);
    expect(p.totalAnnual).toBe(660000);
  });

  it('refuses variable pay that is as large as the CTC it is part of', () => {
    expect(() =>
      preview({
        mode: 'CTC',
        annualCtc: 600000,
        variableAnnual: 600000,
        variableIncludedInCtc: true,
        cityClass: 'METRO',
      }),
    ).toThrow('Variable pay must be less than the annual CTC.');
  });

  it('variable pay is yearly and stays out of the monthly figures', () => {
    const p = preview({
      mode: 'CTC',
      annualCtc: 600000,
      variableAnnual: 60000,
      cityClass: 'METRO',
    });
    expect(p.variableAnnual).toBe(60000);
    expect(p.totalAnnual).toBe(p.ctcAnnual + 60000);
    expect(
      p.lines.find((l) => l.componentCode === 'VARIABLE_PAY'),
    ).toMatchObject({
      valueType: 'MANUAL',
      fixedAmount: 60000,
      amountBasis: 'ANNUAL',
    });
  });

  it('warns when the allowances leave nothing for the Special Allowance', () => {
    const p = preview({
      mode: 'CTC',
      annualCtc: 120000,
      cityClass: 'METRO',
      allowances: { CONVEYANCE: 9000 },
    });
    expect(p.warnings.join(' ')).toMatch(/more than the package/);
  });

  it('warns when Basic is set below 50% of the package', () => {
    const p = preview({
      mode: 'CTC',
      annualCtc: 600000,
      cityClass: 'METRO',
      basicPercent: 40,
    });
    expect(p.warnings.join(' ')).toMatch(/at least 50%/);
  });

  it('refuses a missing amount', () => {
    expect(() => preview({ mode: 'CTC', cityClass: 'METRO' })).toThrow(
      BadRequestException,
    );
    expect(() => preview({ mode: 'GROSS', cityClass: 'METRO' })).toThrow(
      /monthly gross/,
    );
  });

  describe('matches what payroll really pays', () => {
    const cases: [string, StructurePreviewInput][] = [
      [
        'metro permanent 6L',
        {
          mode: 'CTC',
          annualCtc: 600000,
          cityClass: 'METRO',
          employeeType: 'permanent',
        },
      ],
      [
        'non-metro 4.2L with allowances',
        {
          mode: 'CTC',
          annualCtc: 420000,
          cityClass: 'NON_METRO',
          allowances: { CONVEYANCE: 1600 },
        },
      ],
      [
        'village 3L, no HRA',
        { mode: 'CTC', annualCtc: 300000, cityClass: 'RURAL' },
      ],
      [
        'intern 2.4L',
        {
          mode: 'CTC',
          annualCtc: 240000,
          cityClass: 'NON_METRO',
          employeeType: 'intern',
        },
      ],
      [
        'low pay, ESI applies, 2.2L',
        { mode: 'CTC', annualCtc: 220000, cityClass: 'NON_METRO' },
      ],
      [
        'gross 55,000',
        { mode: 'GROSS', monthlyGross: 55000, cityClass: 'METRO' },
      ],
      ['high pay 30L', { mode: 'CTC', annualCtc: 3000000, cityClass: 'METRO' }],
    ];
    it.each(cases)('%s', async (_name, input) => {
      const p = preview(input);
      const run = await engine(p.lines);
      // The structure carries the exact amount; payroll pays the nearest rupee of it.
      expect(run.grossSalary).toBe(Math.round(p.grossMonthly));
      expect(Math.abs(run.ctcMonthly - p.ctcMonthly)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(run.totalEmployerContributions - p.employerMonthly),
      ).toBeLessThanOrEqual(1);
    });
  });
});

describe('employerMonthlyForStructure (the employer share of a saved structure)', () => {
  const cases: [string, StructurePreviewInput][] = [
    ['12L metro', { mode: 'CTC', annualCtc: 1200000, cityClass: 'METRO' }],
    [
      '9L non-metro',
      { mode: 'CTC', annualCtc: 900000, cityClass: 'NON_METRO' },
    ],
    [
      'low pay, ESI applies',
      { mode: 'CTC', annualCtc: 220000, cityClass: 'NON_METRO' },
    ],
    [
      'gross 55,000',
      { mode: 'GROSS', monthlyGross: 55000, cityClass: 'METRO' },
    ],
  ];
  it.each(cases)(
    'reading back the saved lines gives what the builder said: %s',
    (_n, input) => {
      const p = preview(input);
      const readBack = employerMonthlyForStructure({
        components: components(),
        settings: settings(),
        rows: p.lines,
      });
      expect(readBack).toBe(p.employerMonthly);
    },
  );

  it('is zero for a structure with nothing switched on', () => {
    expect(
      employerMonthlyForStructure({
        components: components(),
        settings: settings(),
        rows: [],
      }),
    ).toBe(0);
  });

  it('is zero when the employee has the schemes switched off', () => {
    const p = preview({
      mode: 'CTC',
      annualCtc: 1200000,
      cityClass: 'METRO',
      statutory: {
        pf: false,
        esi: false,
        gratuity: false,
        bonus: false,
        nps: false,
      },
    });
    expect(
      employerMonthlyForStructure({
        components: components(),
        settings: settings(),
        rows: p.lines,
      }),
    ).toBe(0);
  });
});

describe('monthlyFiguresForStructure (the regular month, for tax estimates)', () => {
  it('reads back the pay and the lines the tax workings need', () => {
    const p = preview({ mode: 'CTC', annualCtc: 1200000, cityClass: 'METRO' });
    const f = monthlyFiguresForStructure({
      components: components(),
      settings: settings(),
      rows: p.lines,
    });
    // Payroll pays whole rupees, so the month is the nearest rupee of the pay the builder worked to.
    expect(f.gross).toBe(Math.round(p.grossMonthly));
    expect(f.basic).toBe(p.earnings.find((l) => l.code === 'BASIC')!.monthly);
    expect(f.hra).toBe(
      Math.round(p.earnings.find((l) => l.code === 'HRA')!.monthly),
    );
    expect(f.da).toBe(0);
  });

  it('is all zero for a structure with nothing switched on', () => {
    expect(
      monthlyFiguresForStructure({
        components: components(),
        settings: settings(),
        rows: [],
      }),
    ).toEqual({ gross: 0, basic: 0, da: 0, hra: 0, lta: 0 });
  });
});
