import {
  assertPayrollMonthsUnlocked,
  monthsBetween,
  reopenSignedOffPayrollMonths,
} from './payroll-period-guard';

type Row = Record<string, any>;

const db = (runs: Row[]) => {
  const store = runs.map((r) => ({ ...r }));
  const inSet = (r: Row, w: Row) =>
    (!w.status?.in || w.status.in.includes(r.status)) &&
    (!w.OR ||
      w.OR.some((m: Row) => m.month === r.month && m.year === r.year)) &&
    r.employeeId === w.employeeId;
  return {
    store,
    client: {
      payrollRun: {
        findFirst: async (a: Row) =>
          store.find((r) => inSet(r, a.where)) ?? null,
        updateMany: async (a: Row) => {
          const hits = store.filter((r) => inSet(r, a.where));
          hits.forEach((r) => Object.assign(r, a.data));
          return { count: hits.length };
        },
      },
    } as never,
  };
};

describe('monthsBetween', () => {
  it('lists every month the dates touch, inclusive', () => {
    expect(monthsBetween('2026-09-25', '2026-11-03')).toEqual([
      { month: 9, year: 2026 },
      { month: 10, year: 2026 },
      { month: 11, year: 2026 },
    ]);
  });
  it('a single day is one month', () => {
    expect(monthsBetween('2026-10-10', '2026-10-10')).toEqual([
      { month: 10, year: 2026 },
    ]);
  });
  it('crosses a year end', () => {
    expect(monthsBetween('2026-12-20', '2027-01-05')).toEqual([
      { month: 12, year: 2026 },
      { month: 1, year: 2027 },
    ]);
  });
  it('an end before the start is empty', () => {
    expect(monthsBetween('2026-10-10', '2026-09-01')).toEqual([]);
  });
});

describe('assertPayrollMonthsUnlocked', () => {
  const run = (status: string, month = 9) => ({
    employeeId: 'e1',
    month,
    year: 2026,
    status,
    isFinalSettlement: false,
  });

  it('a locked or paid month refuses the change and says which month and why', async () => {
    for (const status of ['LOCKED', 'PAID']) {
      const { client } = db([run(status)]);
      await expect(
        assertPayrollMonthsUnlocked(
          client,
          'org',
          'e1',
          [{ month: 9, year: 2026 }],
          'leave',
        ),
      ).rejects.toThrow(
        new RegExp(
          `This leave falls within the 9/2026 payroll period, which is already ${status.toLowerCase()}`,
        ),
      );
    }
  });

  it('open or signed-off months do not block it', async () => {
    for (const status of ['DRAFT', 'CALCULATED', 'VERIFIED', 'APPROVED']) {
      const { client } = db([run(status)]);
      await expect(
        assertPayrollMonthsUnlocked(
          client,
          'org',
          'e1',
          [{ month: 9, year: 2026 }],
          'leave',
        ),
      ).resolves.toBeUndefined();
    }
  });

  it('only the months asked about, and only this employee, are looked at', async () => {
    const { client } = db([
      run('PAID', 8),
      { ...run('PAID'), employeeId: 'someone-else' },
    ]);
    await expect(
      assertPayrollMonthsUnlocked(
        client,
        'org',
        'e1',
        [{ month: 9, year: 2026 }],
        'overtime',
      ),
    ).resolves.toBeUndefined();
  });

  it('no months means nothing to check', async () => {
    const { client } = db([run('PAID')]);
    await expect(
      assertPayrollMonthsUnlocked(client, 'org', 'e1', [], 'leave'),
    ).resolves.toBeUndefined();
  });
});

describe('reopenSignedOffPayrollMonths', () => {
  const run = (status: string) => ({
    employeeId: 'e1',
    month: 9,
    year: 2026,
    status,
    isFinalSettlement: false,
  });

  it('a verified or approved run goes back to Calculated so it must be recalculated and signed off again', async () => {
    const { client, store } = db([
      run('VERIFIED'),
      { ...run('APPROVED'), month: 9 },
    ]);
    expect(
      await reopenSignedOffPayrollMonths(client, 'org', 'e1', [
        { month: 9, year: 2026 },
      ]),
    ).toBe(2);
    expect(store.map((r) => r.status)).toEqual(['CALCULATED', 'CALCULATED']);
  });

  it('locked, paid and still-open runs are left exactly as they are', async () => {
    const { client, store } = db([
      run('LOCKED'),
      run('PAID'),
      run('CALCULATED'),
      run('DRAFT'),
    ]);
    expect(
      await reopenSignedOffPayrollMonths(client, 'org', 'e1', [
        { month: 9, year: 2026 },
      ]),
    ).toBe(0);
    expect(store.map((r) => r.status)).toEqual([
      'LOCKED',
      'PAID',
      'CALCULATED',
      'DRAFT',
    ]);
  });

  it('no months means nothing is touched', async () => {
    const { client, store } = db([run('APPROVED')]);
    expect(await reopenSignedOffPayrollMonths(client, 'org', 'e1', [])).toBe(0);
    expect(store[0].status).toBe('APPROVED');
  });
});
