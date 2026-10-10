import { AttendanceStatus as S } from '@prisma/client';
import {
  att,
  defaultSettings,
  fixed,
  leave,
  line,
  makeEngine,
  makeWorld,
  percent,
  slabRow,
  type World,
} from './testing/engine-harness';

// Every day of a month as an attendance row: Sundays are weekly offs, everything else Present unless overridden.
function monthRows(
  year: number,
  month: number,
  over: Record<string, S> = {},
  upTo?: number,
) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = [];
  for (let d = 1; d <= (upTo ?? days); d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    rows.push(att(date, over[date] ?? (sunday ? S.WEEKLY_OFF : S.PRESENT)));
  }
  return rows;
}

const structure = (basic: number, extra: ReturnType<typeof fixed>[] = []) => [
  fixed('BASIC', basic),
  percent('HRA', 40, 'BASIC'),
  ...extra,
];

let world: World;
const SEP = { m: 9, y: 2026 };

afterEach(() => jest.useRealTimers());

describe('payroll engine: a plain full month', () => {
  it('Basic 30,000 + HRA 40% for a full month pays 42,000 with no deductions', async () => {
    world = makeWorld({
      overrides: structure(30000),
      attendance: monthRows(2026, 9),
    });
    const { calc } = makeEngine(world, '2026-10-10');
    const r = await calc(SEP.m, SEP.y);
    expect(line(r.earnings, 'BASIC')).toBe(30000);
    expect(line(r.earnings, 'HRA')).toBe(12000);
    expect(r.grossSalary).toBe(42000);
    expect(r.totalDeductions).toBe(0);
    expect(r.netPay).toBe(42000);
    expect(r.attendanceSummary.payableDays).toBe(30);
    expect(r.attendanceSummary.lopDays).toBe(0);
  });
});

const run = async (
  over: Partial<World>,
  month = SEP.m,
  year = SEP.y,
  today = '2026-10-10',
  options?: Record<string, unknown>,
) => {
  world = makeWorld({
    overrides: structure(30000),
    attendance: monthRows(year, month),
    ...over,
  });
  const e = makeEngine(world, today);
  return e.calc(month, year, options);
};

describe('payroll engine: attendance, leave and proration', () => {
  it('3 absent days: 27 payable days, pay is 27/30 of the full amount', async () => {
    const r = await run({
      attendance: monthRows(2026, 9, {
        '2026-09-02': S.ABSENT,
        '2026-09-03': S.ABSENT,
        '2026-09-04': S.ABSENT,
      }),
    });
    expect(r.attendanceSummary.lopDays).toBe(3);
    expect(r.attendanceSummary.payableDays).toBe(27);
    expect(line(r.earnings, 'BASIC')).toBe(27000);
    expect(line(r.earnings, 'HRA')).toBe(10800);
    expect(r.grossSalary).toBe(37800);
  });

  it('a half day counts as half a day of pay', async () => {
    const r = await run({
      attendance: monthRows(2026, 9, { '2026-09-02': S.HALF_DAY }),
    });
    expect(r.attendanceSummary.payableDays).toBe(29.5);
    expect(r.grossSalary).toBe(Math.round((42000 * 29.5) / 30));
  });

  it('weekly offs and holidays are paid even with no attendance row for them', async () => {
    const rows = monthRows(2026, 9).filter((a) => a.status !== S.WEEKLY_OFF);
    const r = await run({ attendance: rows });
    expect(r.attendanceSummary.payableDays).toBe(30);
    expect(r.grossSalary).toBe(42000);
  });

  it('a company holiday with no punch is paid', async () => {
    const r = await run({
      attendance: monthRows(2026, 9).filter((a) => a.date !== '2026-09-16'),
      holidays: [{ date: '2026-09-16' }],
    });
    expect(r.attendanceSummary.payableDays).toBe(30);
    expect(r.attendanceSummary.lopDays).toBe(0);
  });

  it('a day with no record at all, on a working day, is unpaid', async () => {
    const r = await run({
      attendance: monthRows(2026, 9).filter((a) => a.date !== '2026-09-16'),
    });
    expect(r.attendanceSummary.payableDays).toBe(29);
    expect(r.attendanceSummary.lopDays).toBe(1);
  });

  it('paid leave does not reduce pay; unpaid leave does', async () => {
    const paid = await run({
      attendance: monthRows(2026, 9, {
        '2026-09-08': S.ON_LEAVE,
        '2026-09-09': S.ON_LEAVE,
      }),
      leaves: [leave('2026-09-08', '2026-09-09', 2)],
    });
    expect(paid.attendanceSummary.paidLeaveDays).toBe(2);
    expect(paid.grossSalary).toBe(42000);

    const unpaid = await run({
      attendance: monthRows(2026, 9, {
        '2026-09-08': S.ON_LEAVE,
        '2026-09-09': S.ON_LEAVE,
      }),
      leaves: [
        leave('2026-09-08', '2026-09-09', 2, {
          leaveType: { isPaid: false, salaryImpactPercent: 0, rules: {} },
        }),
      ],
    });
    expect(unpaid.attendanceSummary.unpaidLeaveDays).toBe(2);
    expect(unpaid.grossSalary).toBe(Math.round((42000 * 28) / 30));
  });

  it('someone who joined on 10 Sep is paid only from the 10th (21 of 30 days)', async () => {
    const all = monthRows(2026, 9).filter((a) => a.date >= '2026-09-10');
    const r = await run({
      employee: {
        ...makeWorld().employee,
        joiningDate: new Date('2026-09-10T00:00:00.000Z'),
      },
      attendance: all,
    });
    expect(r.attendanceSummary.daysBeforeJoining).toBe(9);
    expect(r.attendanceSummary.payableDays).toBe(21);
    expect(r.grossSalary).toBe(29400);
  });

  it('a month still running pays only the days that have finished (up to yesterday)', async () => {
    // 10 Oct 2026: days 1-9 are over. Today (10th) has no punch yet and must not be counted as unpaid.
    const r = await run(
      {
        attendance: [
          ...monthRows(2026, 10, {}, 9),
          att('2026-10-10', S.ABSENT),
        ],
      },
      10,
      2026,
      '2026-10-10',
    );
    expect(r.attendanceSummary.daysNotElapsed).toBe(22);
    expect(r.attendanceSummary.payableDays).toBe(9);
    expect(r.attendanceSummary.lopDays).toBe(0);
    expect(r.grossSalary).toBeGreaterThanOrEqual(12193);
    expect(r.grossSalary).toBeLessThanOrEqual(12195);
  });

  it('the 1st of a month does not leave the month with no days at all', async () => {
    const r = await run(
      { attendance: monthRows(2026, 10, {}, 1) },
      10,
      2026,
      '2026-10-01',
    );
    expect(r.attendanceSummary.payableDays).toBe(1);
  });

  it('a manual LOP correction replaces the computed days everywhere downstream', async () => {
    const r = await run({}, SEP.m, SEP.y, '2026-10-10', {
      lopDaysOverride: 5,
    });
    expect(r.attendanceSummary.lopDays).toBe(5);
    expect(r.attendanceSummary.payableDays).toBe(25);
    expect(r.grossSalary).toBe(Math.round((42000 * 25) / 30));
  });

  it('a month of nothing but absence still pays the weekly offs and never goes negative', async () => {
    const all: Record<string, S> = {};
    for (let d = 1; d <= 30; d++) {
      const date = `2026-09-${String(d).padStart(2, '0')}`;
      if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) all[date] = S.ABSENT;
    }
    const r = await run({ attendance: monthRows(2026, 9, all) });
    expect(r.attendanceSummary.payableDays).toBe(4);
    expect(r.netPay).toBeGreaterThanOrEqual(0);
    expect(r.taxDetails?.monthlyTDS ?? 0).toBeGreaterThanOrEqual(0);
  });
});

describe('payroll engine: salary structure', () => {
  it('fails with a clear reason when the employee has no salary structure', async () => {
    await expect(run({ overrides: [] })).rejects.toThrow(
      /No salary structure is set for this employee/,
    );
  });

  it('fails when every component of the structure is switched off', async () => {
    await expect(
      run({ overrides: [{ ...fixed('BASIC', 30000), isEnabled: false }] }),
    ).rejects.toThrow(/No salary structure is set/);
  });

  it('a component switched off for this employee pays nothing', async () => {
    const r = await run({
      overrides: [
        fixed('BASIC', 30000),
        { ...percent('HRA', 40, 'BASIC'), isEnabled: false },
      ],
    });
    expect(line(r.earnings, 'HRA')).toBeUndefined();
    expect(r.grossSalary).toBe(30000);
  });

  it('an extra fixed allowance is added to gross', async () => {
    const r = await run({
      overrides: structure(30000, [fixed('SPECIAL_ALLOWANCE', 5000)]),
    });
    expect(line(r.earnings, 'SPECIAL_ALLOWANCE')).toBe(5000);
    expect(r.grossSalary).toBe(47000);
  });

  it('a raise on 16 Sep is paid at the old rate before it and the new rate from it', async () => {
    const r = await run({
      overrides: [
        { ...fixed('BASIC', 30000), effectiveTo: '2026-09-15' },
        fixed('BASIC', 36000, '2026-09-16'),
        percent('HRA', 40, 'BASIC'),
      ],
    });
    const basic = line(r.earnings, 'BASIC') as number;
    expect(basic).toBeGreaterThan(30000);
    expect(basic).toBeLessThan(36000);
    expect(basic).toBeCloseTo(33000, -2);
  });

  it('money is rounded to the configured decimals, line by line', async () => {
    const r = await run({
      settings: makeWorld().settings,
      overrides: structure(10000),
      attendance: monthRows(2026, 9, { '2026-09-02': S.ABSENT }),
    });
    for (const e of r.earnings) {
      expect(Number.isInteger(e.amount)).toBe(true);
    }
    const sum = r.earnings.reduce((s, e) => s + e.amount, 0);
    expect(sum).toBe(r.grossSalary);
  });
});

describe('payroll engine: statutory deductions and employer contributions', () => {
  it('PF: 12% of Basic up to the 15,000 wage ceiling (1,800), employer pays the same', async () => {
    const r = await run({ settings: defaultSettings({ pfEnabled: true }) });
    expect(line(r.deductions, 'PF')).toBe(1800);
    expect(line(r.employerContributions, 'PF_EMPLOYER')).toBe(1800);
    // The employer's share is NOT taken from the employee, and net = gross - deductions only.
    expect(r.netPay).toBe(r.grossSalary - r.totalDeductions);
  });

  it('PF below the ceiling is 12% of the actual wage', async () => {
    const r = await run({
      settings: defaultSettings({ pfEnabled: true }),
      overrides: structure(10000),
    });
    expect(line(r.deductions, 'PF')).toBe(1200);
  });

  it('PF is off when the switch is off', async () => {
    const r = await run({ settings: defaultSettings({ pfEnabled: false }) });
    expect(line(r.deductions, 'PF')).toBeUndefined();
  });

  it('ESI: 0.75% of wages when gross is within the 21,000 limit', async () => {
    const r = await run({
      settings: defaultSettings({ esiEnabled: true }),
      overrides: structure(14000), // gross 19,600
    });
    expect(r.grossSalary).toBe(19600);
    expect(line(r.deductions, 'ESI')).toBe(147);
    expect(line(r.employerContributions, 'ESI_EMPLOYER')).toBe(637);
  });

  it('ESI does not apply once the monthly structure is above 21,000', async () => {
    const r = await run({
      settings: defaultSettings({ esiEnabled: true }),
      overrides: structure(30000),
    });
    expect(line(r.deductions, 'ESI') ?? 0).toBe(0);
  });

  it('Professional Tax uses the slab for the month gross', async () => {
    const high = await run({ settings: defaultSettings({ ptEnabled: true }) });
    expect(line(high.deductions, 'PT')).toBe(200);
    const mid = await run({
      settings: defaultSettings({ ptEnabled: true }),
      overrides: [fixed('BASIC', 6000)],
    });
    expect(line(mid.deductions, 'PT')).toBe(175);
    const low = await run({
      settings: defaultSettings({ ptEnabled: true }),
      overrides: [fixed('BASIC', 5000)],
    });
    expect(line(low.deductions, 'PT') ?? 0).toBe(0);
  });

  it('Labour Welfare Fund is taken only in its months (June and December)', async () => {
    const june = await run(
      {
        settings: defaultSettings({ lwfEnabled: true }),
        attendance: monthRows(2026, 6),
      },
      6,
      2026,
    );
    expect(line(june.deductions, 'LWF')).toBe(25);
    const sep = await run({ settings: defaultSettings({ lwfEnabled: true }) });
    expect(line(sep.deductions, 'LWF') ?? 0).toBe(0);
    const exempt = await run(
      {
        settings: defaultSettings({ lwfEnabled: true }),
        employee: { ...makeWorld().employee, lwfExempt: true },
        attendance: monthRows(2026, 6),
      },
      6,
      2026,
    );
    expect(line(exempt.deductions, 'LWF') ?? 0).toBe(0);
  });

  it('employer-only costs (NPS, gratuity) never reduce what the employee takes home', async () => {
    const r = await run({
      settings: defaultSettings({ npsEnabled: true, gratuityEnabled: true }),
    });
    expect(line(r.deductions, 'NPS_EMPLOYER')).toBeUndefined();
    expect(line(r.deductions, 'GRATUITY')).toBeUndefined();
    expect(r.totalEmployerContributions).toBeGreaterThan(0);
    expect(r.netPay).toBe(r.grossSalary - r.totalDeductions);
    expect(r.ctcMonthly).toBe(r.grossSalary + r.totalEmployerContributions);
  });

  it('statutory amounts follow the days actually paid, not the full month', async () => {
    const full = await run({
      settings: defaultSettings({ pfEnabled: true }),
      overrides: structure(10000),
    });
    const lop = await run({
      settings: defaultSettings({ pfEnabled: true }),
      overrides: structure(10000),
      attendance: monthRows(2026, 9, {
        '2026-09-02': S.ABSENT,
        '2026-09-03': S.ABSENT,
        '2026-09-04': S.ABSENT,
      }),
    });
    expect(line(lop.deductions, 'PF') as number).toBeLessThan(
      line(full.deductions, 'PF') as number,
    );
  });
});

describe('payroll engine: income tax (TDS)', () => {
  it('a salary under the rebate limit pays no TDS', async () => {
    const r = await run({});
    expect(line(r.deductions, 'INCOME_TAX')).toBe(0);
    expect(r.taxDetails?.regime).toBe('NEW');
    expect(r.taxDetails?.financialYear).toBe('2026-27');
  });

  it('a high salary pays TDS, and the line equals the month TDS in the tax details', async () => {
    const r = await run({ overrides: structure(150000) });
    const tds = line(r.deductions, 'INCOME_TAX') as number;
    expect(tds).toBeGreaterThan(0);
    expect(r.taxDetails?.monthlyTDS).toBe(tds);
    expect(r.netPay).toBe(r.grossSalary - r.totalDeductions);
    expect(r.taxDetails?.deductions.standard).toBe(75000);
  });

  it('a SUBMITTED old-regime declaration switches the regime; a DRAFT is ignored', async () => {
    const decl = (status: string) => ({
      id: 'd1',
      organizationId: 'org-1',
      employeeId: 'emp-1',
      financialYear: '2026-27',
      regimeChosen: 'OLD',
      status,
      section80C: 150000,
    });
    const submitted = await run({
      overrides: structure(150000),
      declaration: decl('SUBMITTED'),
      slabs: [
        slabRow('2026-27', 'NEW' as never),
        slabRow('2026-27', 'OLD' as never),
      ],
    });
    expect(submitted.taxDetails?.regime).toBe('OLD');
    const draft = await run({
      overrides: structure(150000),
      declaration: decl('DRAFT'),
      slabs: [
        slabRow('2026-27', 'NEW' as never),
        slabRow('2026-27', 'OLD' as never),
      ],
    });
    expect(draft.taxDetails?.regime).toBe('NEW');
  });

  it('with "require verification" on, a SUBMITTED declaration is not used yet but a VERIFIED one is', async () => {
    const decl = (status: string) => ({
      id: 'd1',
      organizationId: 'org-1',
      employeeId: 'emp-1',
      financialYear: '2026-27',
      regimeChosen: 'OLD',
      status,
    });
    const slabs = [
      slabRow('2026-27', 'NEW' as never),
      slabRow('2026-27', 'OLD' as never),
    ];
    const settings = defaultSettings({
      taxDeclarationRequiresVerification: true,
    });
    const submitted = await run({
      settings,
      slabs,
      overrides: structure(150000),
      declaration: decl('SUBMITTED'),
    });
    expect(submitted.taxDetails?.regime).toBe('NEW');
    const verified = await run({
      settings,
      slabs,
      overrides: structure(150000),
      declaration: decl('VERIFIED'),
    });
    expect(verified.taxDetails?.regime).toBe('OLD');
  });

  it('Section 206AA: with no valid PAN at least 20% of the month taxable pay is withheld', async () => {
    const settings = defaultSettings({ higherTdsWithoutPan: true });
    const noPan = await run({ settings, overrides: structure(40000) });
    expect(line(noPan.deductions, 'INCOME_TAX')).toBe(
      Math.round(noPan.taxableGross * 0.2),
    );
    const withPan = await run({
      settings,
      overrides: structure(40000),
      employee: {
        ...makeWorld().employee,
        personalData: { panNumber: 'ABCDE1234F' },
      },
    });
    expect(line(withPan.deductions, 'INCOME_TAX')).toBe(0);
  });

  it('fails clearly when no tax slabs exist for the year', async () => {
    await expect(run({ slabs: [] })).rejects.toThrow(
      /No income tax slabs configured for FY 2026-27/,
    );
  });

  it('names the missing regime when only the other regime has slabs', async () => {
    await expect(
      run({ slabs: [slabRow('2026-27', 'OLD' as never)] }),
    ).rejects.toThrow(/for the NEW regime for FY 2026-27/);
  });

  it('on 1 April the previous year slabs are carried forward instead of failing the run', async () => {
    const r = await run(
      { slabs: [slabRow('2025-26')], attendance: monthRows(2026, 4) },
      4,
      2026,
    );
    expect(r.taxDetails?.financialYear).toBe('2026-27');
    expect(world.slabs.some((s) => s.financialYear === '2026-27')).toBe(true);
  });

  it('income tax can be switched off', async () => {
    const r = await run({
      settings: defaultSettings({ incomeTaxEnabled: false }),
      overrides: structure(150000),
    });
    expect(line(r.deductions, 'INCOME_TAX')).toBeUndefined();
    expect(r.taxDetails).toBeNull();
  });

  it('TDS already withheld earlier in the year is taken into account', async () => {
    const earlier = {
      id: 'run-aug',
      organizationId: 'org-1',
      employeeId: 'emp-1',
      month: 8,
      year: 2026,
      financialYear: '2026-27',
      status: 'LOCKED',
      isFinalSettlement: false,
      taxableGross: 300000,
      grossSalary: 300000,
      deductions: [{ code: 'INCOME_TAX', amount: 90000 }],
    };
    const fresh = await run({ overrides: structure(150000) });
    const prepaid = await run({
      overrides: structure(150000),
      runs: [earlier],
    });
    expect(line(prepaid.deductions, 'INCOME_TAX') as number).toBeLessThan(
      line(fresh.deductions, 'INCOME_TAX') as number,
    );
  });
});

describe('payroll engine: one-off earnings and deductions, and safety nets', () => {
  it('an approved leave encashment is added as an earning line', async () => {
    const r = await run({
      encashments: [
        {
          id: 'enc1',
          employeeId: 'emp-1',
          amount: 5000,
          status: 'APPROVED',
        },
      ],
    });
    expect(line(r.earnings, 'LEAVE_ENCASHMENT')).toBe(5000);
    expect(r.grossSalary).toBe(47000);
  });

  it('a loan EMI is shown as a deduction and reduces net pay', async () => {
    const r = await run({
      loans: [
        {
          id: 'loan1',
          organizationId: 'org-1',
          employeeId: 'emp-1',
          status: 'ACTIVE',
          loanType: 'LOAN',
          outstandingBalance: 50000,
          emiAmount: 5000,
          interestRate: 0,
          startMonth: 8,
          startYear: 2026,
        },
      ],
    });
    expect(line(r.deductions, 'LOAN_EMI')).toBe(5000);
    expect(r.netPay).toBe(r.grossSalary - r.totalDeductions);
  });

  it('the last EMI is capped at what is still outstanding', async () => {
    const r = await run({
      loans: [
        {
          id: 'loan1',
          organizationId: 'org-1',
          employeeId: 'emp-1',
          status: 'ACTIVE',
          loanType: 'LOAN',
          outstandingBalance: 1200,
          emiAmount: 5000,
          interestRate: 0,
          startMonth: 8,
          startYear: 2026,
        },
      ],
    });
    expect(line(r.deductions, 'LOAN_EMI')).toBe(1200);
  });

  it('a loan that starts next month is not deducted yet', async () => {
    const r = await run({
      loans: [
        {
          id: 'loan1',
          organizationId: 'org-1',
          employeeId: 'emp-1',
          status: 'ACTIVE',
          loanType: 'LOAN',
          outstandingBalance: 50000,
          emiAmount: 5000,
          interestRate: 0,
          startMonth: 10,
          startYear: 2026,
        },
      ],
    });
    expect(line(r.deductions, 'LOAN_EMI')).toBeUndefined();
  });

  it('fails instead of saving a negative net pay', async () => {
    await expect(
      run({
        loans: [
          {
            id: 'loan1',
            organizationId: 'org-1',
            employeeId: 'emp-1',
            status: 'ACTIVE',
            loanType: 'LOAN',
            outstandingBalance: 500000,
            emiAmount: 100000,
            interestRate: 0,
            startMonth: 8,
            startYear: 2026,
          },
        ],
      }),
    ).rejects.toThrow(/Net pay would be negative/);
  });

  it('fails with "Employee not found" for an unknown employee', async () => {
    world = makeWorld({ overrides: structure(30000) });
    world.employee = null as never;
    const e = makeEngine(world, '2026-10-10');
    await expect(e.calc(9, 2026)).rejects.toThrow(/Employee not found/);
  });

  it('every figure is a finite number (no NaN or Infinity can reach a payslip)', async () => {
    const r = await run({
      settings: defaultSettings({
        pfEnabled: true,
        esiEnabled: true,
        ptEnabled: true,
      }),
    });
    for (const v of [
      r.grossSalary,
      r.totalDeductions,
      r.netPay,
      r.ctcMonthly,
      r.taxableGross,
      r.totalEmployerContributions,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(r.netPay).toBe(r.grossSalary - r.totalDeductions);
  });

  it('the earnings printed on the payslip add up to the printed gross (no 1-rupee drift)', async () => {
    const r = await run({
      overrides: structure(33333, [fixed('SPECIAL_ALLOWANCE', 7777)]),
      attendance: monthRows(2026, 9, {
        '2026-09-02': S.ABSENT,
        '2026-09-03': S.HALF_DAY,
      }),
    });
    expect(r.earnings.reduce((s, e) => s + e.amount, 0)).toBe(r.grossSalary);
    expect(r.deductions.reduce((s, d) => s + d.amount, 0)).toBe(
      r.totalDeductions,
    );
  });
});
