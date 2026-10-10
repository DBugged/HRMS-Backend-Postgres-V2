import { Role } from '@prisma/client';
import { SettlementsService } from './settlements.service';

type Row = Record<string, any>;

interface Opts {
  employee?: Row | null;
  settlements?: Row[];
  runs?: Row[];
  loans?: Row[];
  leaveTypes?: Row[];
  leaveClosing?: number;
  reimbursed?: number;
  calc?: Row;
  basic?: number;
  da?: number;
  gratuityOn?: boolean;
}

const JOINED = new Date('2020-10-07T00:00:00Z');

function build(o: Opts = {}) {
  const employee =
    o.employee === undefined
      ? {
          id: 'e1',
          name: 'Asha',
          isActive: true,
          joiningDate: JOINED,
          employeeType: 'FULL_TIME',
        }
      : o.employee;
  const settlements: Row[] = (o.settlements ?? []).map((s) => ({
    organizationId: 'org',
    ...s,
  }));
  const audit: Row[] = [];
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'organizationId') return true;
      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k]);
      return v === undefined || r[k] === v;
    });
  const tx: Row = {};
  const prisma: Row = {
    user: { findFirst: async () => employee },
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    settlement: {
      findFirst: async (a: Row) => {
        const s = settlements.find((x) => match(x, a?.where));
        return s ? { ...s } : null;
      },
      findFirstOrThrow: async (a: Row) => ({
        ...settlements.find((x) => match(x, a?.where))!,
      }),
      create: async (a: Row) => {
        const row = {
          id: `s${settlements.length + 1}`,
          status: 'DRAFT',
          updatedAt: new Date(),
          ...a.data,
        };
        settlements.push(row);
        return { ...row };
      },
      updateMany: async (a: Row) => {
        const hits = settlements.filter((x) => match(x, a.where));
        hits.forEach((x) => Object.assign(x, a.data));
        return { count: hits.length };
      },
    },
    payrollRun: {
      findFirst: async (a: Row) =>
        (o.runs ?? []).find((r) => {
          if (a.where.isFinalSettlement === true)
            return r.isFinalSettlement === true;
          return (
            !r.isFinalSettlement &&
            (!a.where.status?.in || a.where.status.in.includes(r.status))
          );
        }) ?? null,
    },
    loan: { findMany: async () => o.loans ?? [] },
    leaveType: { findMany: async () => o.leaveTypes ?? [] },
    reimbursement: {
      aggregate: async () => ({ _sum: { amount: o.reimbursed ?? 0 } }),
    },
    $transaction: async (cb: (t: Row) => unknown) => cb(tx),
  };
  const calc = {
    netPay: 40000,
    earnings: [{ code: 'BASIC', name: 'Basic', amount: 40000 }],
    deductions: [] as Row[],
    employerContributions: [],
    taxDetails: null,
    ...o.calc,
  };
  const payrollService = { calculatePayroll: jest.fn(async () => calc) };
  const stub = <T>(x: T) => x as never;
  const service = new SettlementsService(
    stub(prisma),
    stub(payrollService),
    stub({ getOrCreate: async () => ({ gratuityEnabled: !!o.gratuityOn }) }),
    stub({
      getCurrentMonthlyValue: async (_e: string, code: string) =>
        code === 'BASIC' ? (o.basic ?? 30000) : code === 'DA' ? (o.da ?? 0) : 0,
    }),
    stub({
      ensureBalanceRow: async () => ({
        id: 'b1',
        closing: o.leaveClosing ?? 0,
      }),
      forfeitedCarryIn: async () => new Map(),
    }),
    stub({ create: async () => undefined }),
    stub({ send: async () => undefined }),
    stub({ logEvent: async () => undefined }),
    stub({ renderOccasion: async () => ({ subject: 's', html: 'h' }) }),
    stub({ getEffective: async () => ({ version: null }) }),
    stub({ log: async (e: Row) => audit.push(e) }),
  );
  return { service, settlements, audit, payrollService };
}

const admin = { id: 'admin', role: Role.ADMIN } as never;
const dto = (over: Row = {}) =>
  ({ employeeId: 'e1', lastWorkingDay: '2026-10-06', ...over }) as never;
const encashable = [{ id: 'lt1', encashment: { allowed: true } }];

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('final settlement: who can be settled', () => {
  it('an unknown employee, someone who already left, or a bad date is refused', async () => {
    await expect(
      build({ employee: null }).service.calculate(dto(), admin, 'org'),
    ).rejects.toThrow(/Employee not found/);
    const left = build({
      employee: { id: 'e1', isActive: false, joiningDate: JOINED },
    });
    await expect(left.service.calculate(dto(), admin, 'org')).rejects.toThrow(
      /already left/,
    );
    await expect(
      build().service.calculate(
        dto({ lastWorkingDay: 'not-a-date' }),
        admin,
        'org',
      ),
    ).rejects.toThrow(/not a valid date/);
  });

  it('a settlement already processed or paid cannot be calculated again', async () => {
    for (const status of ['PROCESSED', 'PAID']) {
      const { service } = build({
        settlements: [{ id: 's0', employeeId: 'e1', status }],
      });
      await expect(service.calculate(dto(), admin, 'org')).rejects.toThrow(
        new RegExp(`already been ${status.toLowerCase()}`),
      );
    }
  });

  it('the last working day cannot be before joining or still to come', async () => {
    await expect(
      build().service.calculate(
        dto({ lastWorkingDay: '2019-01-01' }),
        admin,
        'org',
      ),
    ).rejects.toThrow(/cannot be before the joining date/);
    await expect(
      build().service.calculate(
        dto({ lastWorkingDay: '2026-11-30' }),
        admin,
        'org',
      ),
    ).rejects.toThrow(/has not come yet/);
  });

  it('an open (calculated but not locked) regular run for the last month blocks it', async () => {
    const { service } = build({
      runs: [{ status: 'CALCULATED', isFinalSettlement: false }],
    });
    await expect(service.calculate(dto(), admin, 'org')).rejects.toThrow(
      /CALCULATED but not locked — lock that run first/i,
    );
  });
});

describe('final settlement: the amounts', () => {
  it('net = pending salary + leave encashment + gratuity + reimbursements - recoveries - loan - notice', async () => {
    const { service } = build({
      gratuityOn: true,
      basic: 26000,
      leaveTypes: encashable,
      leaveClosing: 6, // 6 days x 26,000/30
      reimbursed: 1500,
      loans: [{ outstandingBalance: 20000 }],
      calc: { netPay: 40000 },
    });
    const s = await service.calculate(
      dto({
        recoveriesAmount: 2000,
        noticePeriodRecovery: 5000,
        bonusAmount: 3000,
      }),
      admin,
      'org',
    );
    // 6 completed years of service (7 Oct 2020 to 6 Oct 2026): 26,000 / 26 x 15 x 6 = 90,000
    expect(s.pendingSalaryAmount).toBe(40000);
    expect(s.leaveEncashmentAmount).toBe(Math.round(6 * (26000 / 30)));
    expect(s.gratuityAmount).toBe(90000);
    expect(s.reimbursementAmount).toBe(1500);
    expect(s.loanBalanceRecovered).toBe(20000);
    expect(s.netSettlementAmount).toBe(
      Math.round(
        40000 +
          s.leaveEncashmentAmount +
          3000 +
          90000 +
          1500 -
          2000 -
          20000 -
          5000,
      ),
    );
  });

  it("this month's loan EMI is not charged twice: it is added back because the whole balance is recovered", async () => {
    const { service } = build({
      loans: [{ outstandingBalance: 10000 }],
      calc: {
        netPay: 35000,
        deductions: [{ code: 'LOAN_EMI', name: 'Loan EMI', amount: 5000 }],
      },
    });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.pendingSalaryAmount).toBe(40000); // 35,000 + 5,000 EMI
    expect(s.netSettlementAmount).toBe(40000 - 10000);
  });

  it('when a locked regular run already paid the last month, pending salary is 0 (no double pay)', async () => {
    const { service } = build({
      runs: [{ status: 'PAID', isFinalSettlement: false }],
      calc: { netPay: 40000 },
    });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.pendingSalaryAmount).toBe(0);
    expect(s.pendingSalaryNote).toMatch(
      /already covered by a regular payroll run/,
    );
  });

  it('leave is paid out at Basic ÷ 30 per day, across every type that allows encashment', async () => {
    const { service } = build({
      basic: 30000,
      leaveTypes: [
        ...encashable,
        { id: 'lt2', encashment: { allowed: true } },
        { id: 'lt3', encashment: { allowed: false } },
      ],
      leaveClosing: 3,
    });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.leaveEncashmentAmount).toBe(2 * 3 * 1000); // two encashable types x 3 days x 1,000
  });

  it('bonus and leave encashment are taxed together with the last month (passed to payroll as taxable extras)', async () => {
    const { service, payrollService } = build({
      basic: 30000,
      leaveTypes: encashable,
      leaveClosing: 3,
    });
    await service.calculate(dto({ bonusAmount: 4000 }), admin, 'org');
    const options = (
      payrollService.calculatePayroll.mock.calls[0] as unknown[]
    )[4] as Row;
    expect(options.finalSettlement).toEqual({
      extraTaxableEarnings: 3000 + 4000,
      monthAlreadyPaid: false,
    });
  });

  it('a payroll misconfiguration surfaces as a clear message, not a server error', async () => {
    const { service, payrollService } = build();
    payrollService.calculatePayroll.mockRejectedValueOnce(
      new Error('No income tax slabs configured for FY 2026-27'),
    );
    await expect(service.calculate(dto(), admin, 'org')).rejects.toThrow(
      /Could not calculate the 10\/2026 pending salary: No income tax slabs/,
    );
  });
});

describe('final settlement: gratuity', () => {
  it('is 0 when gratuity is not switched on', async () => {
    const { service } = build({ gratuityOn: false, basic: 26000 });
    expect((await service.calculate(dto(), admin, 'org')).gratuityAmount).toBe(
      0,
    );
  });

  it('is 0 under five years of service, unless the exit is by death or disablement', async () => {
    const recent = {
      id: 'e1',
      name: 'Asha',
      isActive: true,
      joiningDate: new Date('2024-01-01T00:00:00Z'),
      employeeType: 'FULL_TIME',
    };
    const short = build({ gratuityOn: true, basic: 26000, employee: recent });
    expect(
      (await short.service.calculate(dto(), admin, 'org')).gratuityAmount,
    ).toBe(0);
    const death = build({ gratuityOn: true, basic: 26000, employee: recent });
    expect(
      (
        await death.service.calculate(
          dto({ deathOrDisablement: true }),
          admin,
          'org',
        )
      ).gratuityAmount,
    ).toBeGreaterThan(0);
  });

  it('is on Basic plus Dearness Allowance, not Basic alone', async () => {
    const { service } = build({ gratuityOn: true, basic: 20000, da: 6000 });
    expect((await service.calculate(dto(), admin, 'org')).gratuityAmount).toBe(
      90000,
    ); // (20,000 + 6,000) / 26 x 15 x 6
  });
});

describe('final settlement: re-calculating', () => {
  it('a second calculation updates the same draft instead of creating another', async () => {
    const { service, settlements } = build();
    await service.calculate(dto(), admin, 'org');
    await service.calculate(dto({ bonusAmount: 1000 }), admin, 'org');
    expect(settlements).toHaveLength(1);
    expect(settlements[0].bonusAmount).toBe(1000);
  });

  it('is audited with the figures', async () => {
    const { service, audit } = build();
    await service.calculate(dto(), admin, 'org');
    expect(audit.at(-1)).toMatchObject({
      action: 'SETTLEMENT_CALCULATED',
      details: { pendingSalaryAmount: 40000, netSettlementAmount: 40000 },
    });
  });
});

describe('final settlement: processing', () => {
  it('only a draft can be processed, and a negative net cannot', async () => {
    const paid = build({
      settlements: [{ id: 's1', employeeId: 'e1', status: 'PAID' }],
    });
    await expect(paid.service.process('s1', admin, 'org')).rejects.toThrow(
      /Only a draft settlement can be processed/,
    );
    const negative = build({
      settlements: [
        {
          id: 's1',
          employeeId: 'e1',
          status: 'DRAFT',
          netSettlementAmount: -100,
          lastWorkingDay: '2026-10-06',
        },
      ],
    });
    await expect(negative.service.process('s1', admin, 'org')).rejects.toThrow(
      /negative net amount/,
    );
    await expect(
      build().service.process('ghost', admin, 'org'),
    ).rejects.toThrow(/Settlement not found/);
  });

  it('only one final settlement can ever exist for a person', async () => {
    const { service } = build({
      settlements: [
        {
          id: 's1',
          employeeId: 'e1',
          status: 'DRAFT',
          netSettlementAmount: 100,
          lastWorkingDay: '2026-10-06',
        },
      ],
      runs: [{ isFinalSettlement: true, month: 10, year: 2026 }],
    });
    await expect(service.process('s1', admin, 'org')).rejects.toThrow(
      /final settlement has already been processed for this employee \(10\/2026\)/,
    );
  });
});
