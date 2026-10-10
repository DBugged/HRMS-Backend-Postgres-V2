import { AttendanceStatus as S } from '@prisma/client';
import {
  att,
  defaultSettings,
  fixed,
  line,
  makeEngine,
  makeWorld,
  percent,
  type World,
} from './testing/engine-harness';

const monthRows = (year: number, month: number) => {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
    return att(
      date,
      new Date(`${date}T00:00:00Z`).getUTCDay() === 0
        ? S.WEEKLY_OFF
        : S.PRESENT,
    );
  });
};

// A yearly performance bonus on top of Basic + HRA.
const VAR = {
  id: 'c-PERF',
  organizationId: 'org-1',
  name: 'Performance Bonus',
  code: 'PERF',
  type: 'EARNING',
  calcType: 'FIXED',
  percentageOf: null,
  percentageValue: null,
  formula: null,
  defaultValue: 0,
  isTaxable: true,
  includeInGross: true,
  includeInNet: true,
  includeInCTC: true,
  isEmployerContribution: false,
  showOnPayslip: true,
  isStatutory: false,
  statutoryKey: null,
  payFrequency: 'YEARLY',
  displayOrder: 50,
  isActive: true,
  isSystemDefault: false,
};
const perf = {
  ...fixed('PERF', 12000),
  componentId: 'c-PERF',
  componentCode: 'PERF',
};

function world(over: Partial<World> = {}): World {
  const w = makeWorld({
    overrides: [fixed('BASIC', 30000), percent('HRA', 40, 'BASIC'), perf],
    attendance: monthRows(2027, 3),
    ...over,
  });
  w.components = [...w.components, VAR];
  return w;
}
// A yearly component is paid in the last month of the financial year: March 2027 closes FY 2026-27.
const calc = async (w: World, month = 3, year = 2027) => {
  const e = makeEngine(w, '2027-04-10');
  return e.calc(month, year);
};
afterEach(() => jest.useRealTimers());

describe('variable pay (company performance switched off)', () => {
  it('with no rating on file, the variable amount is paid in full', async () => {
    const r = await calc(world());
    expect(line(r.earnings, 'PERF')).toBe(12000);
    expect(r.heldVariablePay).toEqual([]);
  });

  it("an employee's approved rating scales it: 80% of 12,000 is 9,600", async () => {
    const r = await calc(
      world({
        ratings: [
          {
            payoutPercentage: 80,
            financialYear: '2026-27',
            status: 'APPROVED',
          },
        ],
      }),
    );
    expect(line(r.earnings, 'PERF')).toBe(9600);
  });

  it('a rating of 0 pays nothing for it, and 120 pays more', async () => {
    const zero = await calc(
      world({
        ratings: [
          { payoutPercentage: 0, financialYear: '2026-27', status: 'APPROVED' },
        ],
      }),
    );
    expect(line(zero.earnings, 'PERF')).toBe(0);
    const high = await calc(
      world({
        ratings: [
          {
            payoutPercentage: 120,
            financialYear: '2026-27',
            status: 'APPROVED',
          },
        ],
      }),
    );
    expect(line(high.earnings, 'PERF')).toBe(14400);
  });

  it('the regular monthly pay is never scaled by the rating', async () => {
    const r = await calc(
      world({
        ratings: [
          {
            payoutPercentage: 50,
            financialYear: '2026-27',
            status: 'APPROVED',
          },
        ],
      }),
    );
    expect(line(r.earnings, 'BASIC')).toBe(30000);
    expect(line(r.earnings, 'HRA')).toBe(12000);
  });
});

describe('variable pay (company performance switched on)', () => {
  const on = () => defaultSettings({ companyPerformanceEnabled: true });
  const company = (percent: number, departmentId: string | null = null) => ({
    financialYear: '2026-27',
    departmentId,
    achievementPercent: percent,
  });

  it('is held until the company achievement is entered, and shown as held on the run', async () => {
    const r = await calc(world({ settings: on() }));
    expect(line(r.earnings, 'PERF')).toBeUndefined();
    expect(r.heldVariablePay).toEqual([
      expect.objectContaining({ code: 'PERF', financialYear: '2026-27' }),
    ]);
    expect(r.grossSalary).toBe(42000);
  });

  it('once the achievement is entered it is paid as target x company % x individual %', async () => {
    const r = await calc(
      world({
        settings: on(),
        companyPerf: [company(90)],
        ratings: [
          {
            payoutPercentage: 80,
            financialYear: '2026-27',
            status: 'APPROVED',
          },
        ],
      }),
    );
    // 12,000 x 90% x 80% = 8,640
    expect(line(r.earnings, 'PERF')).toBe(8640);
    const lineOut = r.earnings.find((e) => e.code === 'PERF');
    expect(lineOut?.note).toBeTruthy();
    expect(r.heldVariablePay).toEqual([]);
  });

  it('with no rating the individual share is 100%', async () => {
    const r = await calc(world({ settings: on(), companyPerf: [company(75)] }));
    expect(line(r.earnings, 'PERF')).toBe(9000);
  });

  it('a bonus held in March is released in the month the achievement is known', async () => {
    const held = {
      id: 'run-aug',
      organizationId: 'org-1',
      employeeId: 'emp-1',
      month: 3,
      year: 2027,
      financialYear: '2026-27',
      status: 'LOCKED',
      isFinalSettlement: false,
      earnings: [],
      heldVariablePay: [
        {
          code: 'PERF',
          name: 'Performance Bonus',
          cycleKey: '2027-03',
          financialYear: '2026-27',
        },
      ],
      taxableGross: 0,
      deductions: [],
    };
    // April 2027: the yearly bonus is not due this month, but the one held in March can now be paid.
    const r = await calc(
      world({
        settings: on(),
        companyPerf: [company(100)],
        runs: [held],
        attendance: monthRows(2027, 4),
      }),
      4,
      2027,
    );
    const released = r.earnings.find(
      (e) => e.code === 'PERF' && /FY 2026-27/.test(e.name),
    );
    expect(released).toBeTruthy();
    expect(released?.amount).toBe(12000);
  });
});
