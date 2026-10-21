// Worked PF and ESI examples, each checked against the figure worked out by hand from the rules (EPFO / ESIC), through
// the real payroll engine. Salaries are set with Basic only (the default HRA is 40% of Basic, so gross = Basic x 1.4
// where it matters for ESI). September 2026, a 30-day month with Sundays off, unless a test says otherwise.
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
const employer = (r: { employerContributions: any[] }, code: string) =>
  r.employerContributions.find((e) => e.code === code);

const pf = { settings: defaultSettings({ pfEnabled: true }) };
const esi = { settings: defaultSettings({ esiEnabled: true }) };

describe('PF: worked examples (ceiling 15,000, 12% + 12%)', () => {
  it('Basic 12,000: 1,440 each side; EPS 8.33% = 1,000, EPF 440; EDLI 60; admin 60', async () => {
    const r = await run({ ...pf, overrides: [fixed('BASIC', 12000)] });
    expect(line(r.deductions, 'PF')).toBe(1440);
    expect(line(r.employerContributions, 'PF_EMPLOYER')).toBe(1440);
    expect(employer(r, 'PF_EMPLOYER').breakup).toMatchObject({
      eps: 1000,
      epf: 440,
    });
    expect(line(r.employerContributions, 'EDLI_EMPLOYER')).toBe(60);
    expect(line(r.employerContributions, 'EPF_ADMIN_EMPLOYER')).toBe(60);
  });

  it('Basic 15,000: 1,800; EPS rounds 1,249.5 up to 1,250, EPF 550', async () => {
    const r = await run({ ...pf, overrides: [fixed('BASIC', 15000)] });
    expect(line(r.deductions, 'PF')).toBe(1800);
    expect(employer(r, 'PF_EMPLOYER').breakup).toMatchObject({
      eps: 1250,
      epf: 550,
    });
  });

  it('Basic 30,000: PF stops at the ceiling (1,800), EDLI capped at 75, admin on 15,000 = 75', async () => {
    const r = await run({ ...pf, overrides: [fixed('BASIC', 30000)] });
    expect(line(r.deductions, 'PF')).toBe(1800);
    expect(line(r.employerContributions, 'EDLI_EMPLOYER')).toBe(75);
    expect(line(r.employerContributions, 'EPF_ADMIN_EMPLOYER')).toBe(75);
  });

  it('PF follows the wages actually earned: Basic 20,000 with 10 days of loss of pay is on 13,333 = 1,600', async () => {
    const absent: Record<string, S> = {};
    for (const d of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11]) {
      absent[`2026-09-${String(d).padStart(2, '0')}`] = S.ABSENT;
    }
    const r = await run({
      ...pf,
      overrides: [fixed('BASIC', 20000)],
      attendance: monthRows(2026, 9, absent),
    });
    expect(line(r.deductions, 'PF')).toBe(1600);
  });

  describe('Labour Codes 50% wages rule and contributing on actual wages (Basic 15,000, HRA 200%: gross 45,000)', () => {
    const rich = [fixed('BASIC', 15000), percent('HRA', 200, 'BASIC')];
    const version = (config: Record<string, unknown>) => [
      {
        id: 'v1',
        module: 'PF',
        effectiveFrom: '2020-01-01',
        effectiveTo: null,
        isEnabled: true,
        config: {
          employeeRate: 12,
          employerRate: 12,
          wageCeiling: 15000,
          edliRate: 0.5,
          adminChargeRate: 0.5,
          epsRate: 8.33,
          edliMaxAmount: 75,
          ...config,
        },
      },
    ];
    const pfWith = async (config: Record<string, unknown>) =>
      line(
        (
          await run({
            ...pf,
            overrides: rich,
            statutoryVersions: version(config),
          })
        ).deductions,
        'PF',
      );

    it('capped at the ceiling whether or not the 50% rule is on', async () => {
      expect(await pfWith({})).toBe(1800);
      expect(await pfWith({ applyFiftyPercentRule: true })).toBe(1800);
    });
    it('on actual wages, the Basic is 15,000 so still 1,800 - until the 50% rule lifts the wages to 22,500 (2,700)', async () => {
      expect(await pfWith({ contributeOnActualWages: true })).toBe(1800);
      expect(
        await pfWith({
          contributeOnActualWages: true,
          applyFiftyPercentRule: true,
        }),
      ).toBe(2700);
    });
  });
});

describe('ESI: worked examples (ceiling 21,000, 0.75% + 3.25%)', () => {
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

  it('gross 18,000: 135 and 585', async () => {
    expect(await esiFor(12857)).toEqual({
      gross: 18000,
      employee: 135,
      employer: 585,
    });
  });

  it('gross 20,300: 152.25 -> 152 and 659.75 -> 660 (nearest rupee)', async () => {
    expect(await esiFor(14500)).toEqual({
      gross: 20300,
      employee: 152,
      employer: 660,
    });
  });

  it('gross exactly 21,000 is still covered (157.5 -> 158, 682.5 -> 683); 21,001 is not', async () => {
    expect(await esiFor(15000)).toEqual({
      gross: 21000,
      employee: 158,
      employer: 683,
    });
    expect(await esiFor(15001)).toEqual({
      gross: 21001,
      employee: 0,
      employer: 0,
    });
  });

  it('an average daily wage of 176 or less pays no employee share, the employer still pays; above 176 both pay', async () => {
    expect(await esiFor(3771)).toEqual({
      gross: 5279,
      employee: 0,
      employer: 172,
    });
    expect(await esiFor(3772)).toEqual({
      gross: 5281,
      employee: 40,
      employer: 172,
    });
  });
});
