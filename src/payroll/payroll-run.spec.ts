import { AttendanceStatus as S, Role } from '@prisma/client';
import { PayrollService } from './payroll.service';

type Row = Record<string, any>;

const emp = (id: string, over: Row = {}): Row => ({
  id,
  organizationId: 'org',
  name: `Emp ${id}`,
  employeeId: `DP-${id}`,
  role: 'EMPLOYEE',
  isActive: true,
  excludeFromPayroll: false,
  joiningDate: new Date('2024-01-01T00:00:00Z'),
  departmentId: null,
  designation: 'Dev',
  gradeLevel: null,
  personalData: {
    bankAccountNo: '123',
    bankIFSC: 'HDFC0000001',
    panNumber: 'ABCDE1234F',
  },
  ...over,
});

const calcResult = (over: Row = {}): Row => ({
  attendanceSummary: { payableDays: 30 },
  earnings: [{ code: 'BASIC', name: 'Basic', amount: 42000, taxable: true }],
  deductions: [],
  employerContributions: [],
  taxDetails: null,
  grossSalary: 42000,
  taxableGross: 42000,
  totalDeductions: 0,
  totalEmployerContributions: 0,
  netPay: 42000,
  ctcMonthly: 42000,
  financialYear: '2026-27',
  heldVariablePay: [],
  ...over,
});

function build(employees: Row[], runs: Row[] = [], extraPrisma: Row = {}) {
  const store: Row[] = runs.map((r) => ({ ...r }));
  const audit: Row[] = [];
  let seq = 0;
  const match = (r: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'organizationId') return true;
      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k]);
      return v === undefined || r[k] === v;
    });
  const prisma: Row = {
    user: {
      findMany: async (a: Row) => {
        const notIn: string[] = a?.where?.id?.notIn ?? [];
        return employees.filter(
          (e) => e.isActive && !e.excludeFromPayroll && !notIn.includes(e.id),
        );
      },
      findFirst: async (a: Row) =>
        employees.find((e) => e.id === a?.where?.id && e.isActive) ?? null,
    },
    department: { findMany: async () => [] },
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    payrollRun: {
      findMany: async (a: Row) => store.filter((r) => match(r, a?.where)),
      findFirst: async (a: Row) =>
        store.find((r) => match(r, a?.where)) ?? null,
      findFirstOrThrow: async (a: Row) => {
        const r = store.find((x) => match(x, a?.where));
        if (!r) throw new Error('not found');
        return r;
      },
      createMany: async (a: Row) => {
        a.data.forEach((d: Row) =>
          store.push({ id: `run${++seq}`, isFinalSettlement: false, ...d }),
        );
        return { count: a.data.length };
      },
      create: async (a: Row) => {
        const row = { id: `run${++seq}`, isFinalSettlement: false, ...a.data };
        store.push(row);
        return row;
      },
      updateMany: async (a: Row) => {
        const hits = store.filter(
          (r) =>
            r.id === a.where.id &&
            (!a.where.status?.in || a.where.status.in.includes(r.status)),
        );
        hits.forEach((r) => Object.assign(r, a.data));
        return { count: hits.length };
      },
      deleteMany: async (a: Row) => {
        const before = store.length;
        for (let i = store.length - 1; i >= 0; i--)
          if (store[i].id === a.where.id) store.splice(i, 1);
        return { count: before - store.length };
      },
    },
    holiday: { findMany: async () => [] },
    attendance: { findMany: async () => [] },
    $transaction: async () => 'PS-0001',
    ...extraPrisma,
  };
  const settings = {
    roundingRule: 'nearest',
    roundingDecimals: 0,
    getOrCreate: async () => ({ roundingRule: 'nearest', roundingDecimals: 0 }),
  };
  const stub = <T>(x: T) => x as never;
  const service = new PayrollService(
    stub(prisma),
    stub(settings),
    stub({ getEffective: async () => ({ version: null }) }),
    stub({ log: async (e: Row) => audit.push(e) }),
    stub({ logEvent: async () => undefined }),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
  );
  return { service, store, audit };
}

const admin = { id: 'admin', role: Role.ADMIN } as never;
const hrUser = (id = 'hr1') => ({ id, role: Role.HR }) as never;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z'));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('payroll draft', () => {
  it('creates one Draft row per employee, holding no amounts', async () => {
    const { service, store } = build([emp('1'), emp('2')]);
    const r = await service.draft(
      { month: 10, year: 2026 } as never,
      admin,
      'org',
    );
    expect(r.count).toBe(2);
    expect(r.created).toBe(2);
    expect(store.map((x) => x.status)).toEqual(['DRAFT', 'DRAFT']);
  });

  it('running it again does not create duplicates', async () => {
    const { service, store } = build([emp('1')]);
    await service.draft({ month: 10, year: 2026 } as never, admin, 'org');
    const again = await service.draft(
      { month: 10, year: 2026 } as never,
      admin,
      'org',
    );
    expect(again.created).toBe(0);
    expect(again.count).toBe(1);
    expect(store).toHaveLength(1);
  });

  it('a month that has not started cannot be drafted', async () => {
    const { service } = build([emp('1')]);
    await expect(
      service.draft({ month: 12, year: 2026 } as never, admin, 'org'),
    ).rejects.toThrow(/that month has not started/);
  });

  it('someone who joined after the month, or joins in the future, is left out with the reason', async () => {
    const { service, store } = build([
      emp('1'),
      emp('late', { joiningDate: new Date('2026-11-05T00:00:00Z') }),
    ]);
    const r = await service.draft(
      { month: 10, year: 2026 } as never,
      admin,
      'org',
    );
    expect(store).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/Joined after 10\/2026/);
    const f = await service.draft(
      { month: 10, year: 2026 } as never,
      admin,
      'org',
    );
    expect(f.skipped[0].reason).toMatch(/Joined after/);
  });

  it('inactive people, standing opt-outs and per-run exclusions are not drafted', async () => {
    const { service, store } = build([
      emp('1'),
      emp('2', { isActive: false }),
      emp('3', { excludeFromPayroll: true }),
      emp('4'),
    ]);
    await service.draft(
      { month: 10, year: 2026, excludeEmployeeIds: ['4'] } as never,
      admin,
      'org',
    );
    expect(store.map((x) => x.employeeId)).toEqual(['1']);
  });

  it('a single named employee must exist', async () => {
    const { service } = build([emp('1')]);
    await expect(
      service.draft(
        { month: 10, year: 2026, employeeId: 'ghost' } as never,
        admin,
        'org',
      ),
    ).rejects.toThrow(/Employee not found/);
  });
});

describe('payroll calculate', () => {
  it('creates a Calculated row with the payslip number, amounts in words and who calculated it', async () => {
    const { service, store } = build([emp('1')]);
    jest
      .spyOn(service, 'calculatePayroll')
      .mockResolvedValue(calcResult() as never);
    const r = await service.calculate(
      { month: 9, year: 2026 } as never,
      hrUser('hr9'),
      'org',
    );
    expect(r.count).toBe(1);
    expect(r.failures).toEqual([]);
    expect(store[0]).toMatchObject({
      status: 'CALCULATED',
      payslipNumber: 'PS-0001',
      grossSalary: 42000,
      netPay: 42000,
      calculatedById: 'hr9',
    });
    expect(store[0].netPayInWords).toMatch(/Forty Two Thousand/i);
  });

  it('Calculate after Create Draft fills the same row instead of adding another', async () => {
    const { service, store } = build([emp('1')]);
    jest
      .spyOn(service, 'calculatePayroll')
      .mockResolvedValue(calcResult() as never);
    await service.draft({ month: 9, year: 2026 } as never, admin, 'org');
    await service.calculate({ month: 9, year: 2026 } as never, admin, 'org');
    expect(store).toHaveLength(1);
    expect(store[0].status).toBe('CALCULATED');
  });

  it('recalculating keeps the payslip number it was first given', async () => {
    const { service, store } = build([emp('1')]);
    jest
      .spyOn(service, 'calculatePayroll')
      .mockResolvedValue(calcResult() as never);
    await service.calculate({ month: 9, year: 2026 } as never, admin, 'org');
    store[0].payslipNumber = 'PS-0007';
    await service.calculate({ month: 9, year: 2026 } as never, admin, 'org');
    expect(store[0].payslipNumber).toBe('PS-0007');
  });

  it('Approved, Locked and Paid rows are not recalculated and are reported as skipped', async () => {
    const base = {
      month: 9,
      year: 2026,
      isFinalSettlement: false,
      grossSalary: 1,
    };
    const { service, store } = build(
      [emp('1'), emp('2'), emp('3'), emp('4')],
      [
        { id: 'a', employeeId: '1', status: 'APPROVED', ...base },
        { id: 'b', employeeId: '2', status: 'LOCKED', ...base },
        { id: 'c', employeeId: '3', status: 'PAID', ...base },
        { id: 'd', employeeId: '4', status: 'VERIFIED', ...base },
      ],
    );
    const spy = jest
      .spyOn(service, 'calculatePayroll')
      .mockResolvedValue(calcResult() as never);
    const r = await service.calculate(
      { month: 9, year: 2026 } as never,
      admin,
      'org',
    );
    expect(spy).toHaveBeenCalledTimes(1); // only the Verified one
    expect(r.skipped.map((s) => s.reason).sort()).toEqual([
      'Payroll run is APPROVED — not recalculated.',
      'Payroll run is LOCKED — not recalculated.',
      'Payroll run is PAID — not recalculated.',
    ]);
    expect(store.find((x) => x.id === 'a')?.grossSalary).toBe(1);
    expect(store.find((x) => x.id === 'd')?.status).toBe('CALCULATED');
  });

  it("one employee's failure does not stop the others, and says who and why", async () => {
    const { service, store } = build([emp('1'), emp('2')]);
    jest
      .spyOn(service, 'calculatePayroll')
      .mockImplementation(async (id: string) => {
        if (id === '2')
          throw new Error('No salary structure is set for this employee');
        return calcResult() as never;
      });
    const r = await service.calculate(
      { month: 9, year: 2026 } as never,
      admin,
      'org',
    );
    expect(r.count).toBe(1);
    expect(r.failures).toEqual([
      expect.objectContaining({
        name: 'Emp 2',
        code: 'DP-2',
        message: expect.stringMatching(/No salary structure/),
      }),
    ]);
    expect(store).toHaveLength(1);
  });

  it('a calculation that came out as NaN is never saved', async () => {
    const { service, store } = build([emp('1')]);
    jest
      .spyOn(service, 'calculatePayroll')
      .mockResolvedValue(calcResult({ netPay: Number.NaN }) as never);
    const r = await service.calculate(
      { month: 9, year: 2026 } as never,
      admin,
      'org',
    );
    expect(r.count).toBe(0);
    expect(r.failures[0].message).toMatch(
      /non-numeric amount \(netPay\) — not saved/,
    );
    expect(store).toHaveLength(0);
  });

  it('a stale Draft for someone who had not joined yet is removed', async () => {
    const { service, store } = build(
      [emp('late', { joiningDate: new Date('2026-10-05T00:00:00Z') })],
      [
        {
          id: 'stale',
          employeeId: 'late',
          month: 9,
          year: 2026,
          status: 'DRAFT',
          isFinalSettlement: false,
        },
      ],
    );
    const spy = jest.spyOn(service, 'calculatePayroll');
    const r = await service.calculate(
      { month: 9, year: 2026 } as never,
      admin,
      'org',
    );
    expect(spy).not.toHaveBeenCalled();
    expect(r.skipped[0].reason).toMatch(/Joined after 9\/2026/);
    expect(store).toHaveLength(0);
  });

  it('warns (without blocking) about a missing bank account, IFSC or PAN', async () => {
    const { service } = build([
      emp('1', { personalData: { panNumber: 'ABCDE1234F' } }),
    ]);
    jest
      .spyOn(service, 'calculatePayroll')
      .mockResolvedValue(calcResult() as never);
    const r = await service.calculate(
      { month: 9, year: 2026 } as never,
      admin,
      'org',
    );
    expect(r.count).toBe(1);
    expect(r.warnings).toEqual([
      expect.objectContaining({
        name: 'Emp 1',
        missing: ['Bank account number', 'IFSC code'],
      }),
    ]);
  });

  it('a month that has not started cannot be calculated', async () => {
    const { service } = build([emp('1')]);
    await expect(
      service.calculate({ month: 12, year: 2026 } as never, admin, 'org'),
    ).rejects.toThrow(/that month has not started/);
  });

  it('is written to the audit log with the counts', async () => {
    const { service, audit } = build([emp('1')]);
    jest
      .spyOn(service, 'calculatePayroll')
      .mockResolvedValue(calcResult() as never);
    await service.calculate({ month: 9, year: 2026 } as never, admin, 'org');
    expect(audit.at(-1)).toMatchObject({
      action: 'PAYROLL_CALCULATED',
      details: { count: 1, failed: 0, skipped: 0 },
    });
  });
});

describe('payroll manual adjustment', () => {
  const stored = (over: Row = {}): Row => ({
    id: 'r1',
    employeeId: 'emp',
    month: 9,
    year: 2026,
    status: 'CALCULATED',
    isFinalSettlement: false,
    earnings: [{ code: 'BASIC', name: 'Basic', amount: 42000, taxable: true }],
    deductions: [{ code: 'PF', name: 'PF', amount: 1800 }],
    totalEmployerContributions: 1800,
    taxDetails: null,
    ...over,
  });
  const setup = (run: Row) => {
    const b = build([emp('emp')], [run]);
    (b.service as never as Row).payrollSettingsService = {
      getOrCreate: async () => ({
        roundingRule: 'nearest',
        roundingDecimals: 0,
      }),
    };
    return b;
  };

  it('editing a deduction recomputes the totals and net pay', async () => {
    const { service, store } = setup(stored());
    await service.adjust(
      'r1',
      { deductions: [{ code: 'PF', name: 'PF', amount: 1000 }] } as never,
      admin,
      'org',
    );
    expect(store[0]).toMatchObject({
      totalDeductions: 1000,
      netPay: 41000,
      grossSalary: 42000,
    });
    expect(store[0].netPayInWords).toBeTruthy();
  });

  it('an edit that would make the net pay negative is refused', async () => {
    const { service } = setup(stored());
    await expect(
      service.adjust(
        'r1',
        { deductions: [{ code: 'PF', name: 'PF', amount: 99999 }] } as never,
        admin,
        'org',
      ),
    ).rejects.toThrow(/make the net pay negative/);
  });

  it('a Verified run that is edited goes back to Calculated', async () => {
    const { service, store } = setup(stored({ status: 'VERIFIED' }));
    await service.adjust(
      'r1',
      { deductions: [{ code: 'PF', name: 'PF', amount: 1000 }] } as never,
      admin,
      'org',
    );
    expect(store[0].status).toBe('CALCULATED');
  });

  it('Approved, Locked and Paid runs cannot be edited', async () => {
    for (const status of ['APPROVED', 'LOCKED', 'PAID']) {
      const { service } = setup(stored({ status }));
      await expect(
        service.adjust('r1', { deductions: [] } as never, admin, 'org'),
      ).rejects.toThrow(/can no longer be edited/);
    }
  });

  it('HR cannot edit their own payslip; an unknown run is not found', async () => {
    const own = setup(stored({ employeeId: 'me' }));
    await expect(
      own.service.adjust(
        'r1',
        { deductions: [] } as never,
        hrUser('me'),
        'org',
      ),
    ).rejects.toThrow(/your own payslip/);
    const none = setup(stored());
    await expect(
      none.service.adjust('ghost', { deductions: [] } as never, admin, 'org'),
    ).rejects.toThrow(/not found/);
  });

  it('an edited TDS line is shown in the tax details and flagged as manual', async () => {
    const { service, store } = setup(
      stored({
        deductions: [{ code: 'INCOME_TAX', name: 'TDS', amount: 500 }],
        taxDetails: { monthlyTDS: 500, regime: 'NEW' },
      }),
    );
    await service.adjust(
      'r1',
      {
        deductions: [{ code: 'INCOME_TAX', name: 'TDS', amount: 800 }],
      } as never,
      admin,
      'org',
    );
    expect(store[0].taxDetails).toMatchObject({
      monthlyTDS: 800,
      manuallyAdjusted: true,
      regime: 'NEW',
    });
  });

  it('an edited earning keeps the taxable flag the line had before', async () => {
    const { service, store } = setup(stored());
    await service.adjust(
      'r1',
      { earnings: [{ code: 'BASIC', name: 'Basic', amount: 40000 }] } as never,
      admin,
      'org',
    );
    expect(store[0].taxableGross).toBe(40000);
  });
});

describe('attendance gaps warning', () => {
  it('counts only finished working days with no record, not offs, holidays or today', async () => {
    // 10 Oct 2026, a Saturday. Days 1-9 are finished; Sunday the 4th is a weekly off; the 2nd is a holiday.
    const marked = ['2026-10-01', '2026-10-05', '2026-10-06'].map((date) => ({
      employeeId: '1',
      date,
      status: S.PRESENT,
    }));
    const { service } = build([emp('1')], [], {
      attendance: { findMany: async () => marked },
      holiday: {
        findMany: async () => [{ date: '2026-10-02', departmentId: null }],
      },
    });
    const gaps = await service.getAttendanceGaps(10, 2026, 'org');
    // working days 1..9 minus Sunday(4) minus holiday(2) = 1,3,5,6,7,8,9; marked 1,5,6 -> unmarked 3,7,8,9
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      unmarkedDays: 4,
      daysSoFar: 9,
      totalDaysInMonth: 31,
    });
  });

  it('an employee with every working day marked is not listed', async () => {
    const days = [1, 2, 3, 5, 6, 7, 8, 9].map((d) => ({
      employeeId: '1',
      date: `2026-10-0${d}`,
      status: S.PRESENT,
    }));
    const { service } = build([emp('1')], [], {
      attendance: { findMany: async () => days },
    });
    expect(await service.getAttendanceGaps(10, 2026, 'org')).toEqual([]);
  });

  it('a day before the employee joined is not their gap', async () => {
    const { service } = build(
      [emp('1', { joiningDate: new Date('2026-10-08T00:00:00Z') })],
      [],
      { attendance: { findMany: async () => [] } },
    );
    const gaps = await service.getAttendanceGaps(10, 2026, 'org');
    expect(gaps[0]).toMatchObject({ unmarkedDays: 2, daysSoFar: 2 }); // 8th and 9th
  });

  it('lists the worst gaps first', async () => {
    const { service } = build(
      [emp('a'), emp('b', { joiningDate: new Date('2026-10-07T00:00:00Z') })],
      [],
      { attendance: { findMany: async () => [] } },
    );
    const gaps = await service.getAttendanceGaps(10, 2026, 'org');
    expect(gaps.map((g) => g.employeeId)).toEqual(['a', 'b']);
  });
});
