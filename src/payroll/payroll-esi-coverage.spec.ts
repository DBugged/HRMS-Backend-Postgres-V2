// ESI: an employee covered in a contribution period (Apr-Sep / Oct-Mar) stays covered for the rest of it, even when
// wages cross the ceiling; coverage means ESI was charged - the employee's share OR the employer's (a daily-wage-exempt
// employee pays no share but is covered). Through the real payroll engine. Salaries are Basic only (the default HRA is
// 40% of Basic, so gross = Basic x 1.4); September 2026, a 30-day month with Sundays off, unless a test says otherwise.
import { AttendanceStatus as S } from '@prisma/client';
import {
  att,
  defaultSettings,
  fixed,
  line,
  makeEngine,
  makeWorld,
  type World,
} from './testing/engine-harness';

function monthRows(year: number, month: number, over: Record<string, S> = {}) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows: ReturnType<typeof att>[] = [];
  for (let d = 1; d <= days; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    rows.push(att(date, over[date] ?? (sunday ? S.WEEKLY_OFF : S.PRESENT)));
  }
  return rows;
}

const run = async (
  over: Partial<World>,
  month = 9,
  year = 2026,
  today = '2026-10-10',
) => {
  const world = makeWorld({ attendance: monthRows(year, month), ...over });
  return makeEngine(world, today).calc(month, year);
};
const esi = { settings: defaultSettings({ esiEnabled: true }) };

describe('ESI: coverage through the contribution period', () => {
  const july = (amounts: { employee: number; employer: number }) => ({
    runs: [
      {
        organizationId: 'org-1',
        employeeId: 'emp-1',
        isFinalSettlement: false,
        runSequence: 0,
        status: 'PAID',
        month: 7,
        year: 2026,
        deductions: [{ code: 'ESI', amount: amounts.employee }],
        employerContributions: [
          { code: 'ESI_EMPLOYER', amount: amounts.employer },
        ],
      },
    ],
  });
  const esiFor = async (
    basic: number,
    extra: Partial<World> = {},
    ...when: [number?, number?, string?]
  ) => {
    const [month = 9, year = 2026, today = '2026-10-10'] = when;
    const r = await run(
      { ...esi, overrides: [fixed('BASIC', basic)], ...extra },
      month,
      year,
      today,
    );
    return {
      gross: r.grossSalary,
      employee: line(r.deductions, 'ESI') ?? 0,
      employer: line(r.employerContributions, 'ESI_EMPLOYER') ?? 0,
    };
  };

  it('covered earlier in the period (Apr-Sep), still covered when wages cross the ceiling in September', async () => {
    expect(await esiFor(16429, july({ employee: 154, employer: 667 }))).toEqual(
      {
        gross: 23001,
        employee: 173,
        employer: 748,
      },
    );
  });

  it('coverage also continues when the earlier employee share was 0 (daily-wage exempt) - the employer share counts as ESI having been charged', async () => {
    expect(await esiFor(16429, july({ employee: 0, employer: 172 }))).toEqual({
      gross: 23001,
      employee: 173,
      employer: 748,
    });
  });

  it('a new contribution period (October) re-tests coverage: gross 23,001 is out', async () => {
    const sep = {
      runs: [
        {
          organizationId: 'org-1',
          employeeId: 'emp-1',
          isFinalSettlement: false,
          runSequence: 0,
          status: 'PAID',
          month: 9,
          year: 2026,
          deductions: [{ code: 'ESI', amount: 173 }],
          employerContributions: [{ code: 'ESI_EMPLOYER', amount: 748 }],
        },
      ],
    };
    expect(
      await esiFor(
        16429,
        { ...sep, attendance: monthRows(2026, 10) },
        10,
        2026,
        '2026-11-10',
      ),
    ).toEqual({ gross: 23001, employee: 0, employer: 0 });
  });

  it('a covered period only counts earlier runs of this employee, not a different month outside the period', async () => {
    // March 2026 belongs to the previous Oct-Mar period; it must not carry coverage into April-September.
    const march = {
      runs: [
        {
          organizationId: 'org-1',
          employeeId: 'emp-1',
          isFinalSettlement: false,
          runSequence: 0,
          status: 'PAID',
          month: 3,
          year: 2026,
          deductions: [{ code: 'ESI', amount: 150 }],
          employerContributions: [{ code: 'ESI_EMPLOYER', amount: 650 }],
        },
      ],
    };
    expect(await esiFor(16429, march)).toEqual({
      gross: 23001,
      employee: 0,
      employer: 0,
    });
  });
});
