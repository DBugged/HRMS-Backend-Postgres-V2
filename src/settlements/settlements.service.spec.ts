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
  openCase?: Row | null;
  resignation?: Row | null;
  defaultNotice?: number;
  policies?: Row;
  bonusOn?: boolean;
  gratuityConfig?: Row;
  headcount?: number;
  signedRuns?: Row[];
  paidRuns?: Row[];
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
  const unlinked: Row[] = [];
  const linked: Row[] = [];
  const tx: Row = {
    offboardingCase: {
      updateMany: async (a: Row) => {
        unlinked.push(a.where);
        return { count: 1 };
      },
    },
    settlement: {
      deleteMany: async (a: Row) => {
        const i = settlements.findIndex((x) => match(x, a.where));
        if (i >= 0) settlements.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      },
    },
  };
  const prisma: Row = {
    user: {
      findFirst: async () => employee,
      count: async () => o.headcount ?? 1,
    },
    organization: {
      findFirst: async () => ({
        timezone: 'Asia/Kolkata',
        policies: { defaultNoticeDays: o.defaultNotice ?? 0, ...o.policies },
      }),
    },
    leave: { count: async () => 0 },
    resignation: { findFirst: async () => o.resignation ?? null },
    offboardingCase: { findFirst: async () => o.openCase ?? null, updateMany: async (a: Row) => { linked.push(a); return { count: 1 }; } },
    leaveEncashment: { count: async () => 0 },
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
      findMany: async (a: Row) =>
        a.where.runSequence === 0 ? (o.signedRuns ?? []) : (o.paidRuns ?? []),
    },
    loan: { findMany: async () => o.loans ?? [] },
    leaveType: { findMany: async () => o.leaveTypes ?? [] },
    reimbursement: {
      aggregate: async () => ({ _sum: { amount: o.reimbursed ?? 0 } }),
      count: async () => 0,
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
    stub({
      getOrCreate: async () => ({
        gratuityEnabled: !!o.gratuityOn,
        financialYearStartMonth: 4,
      }),
    }),
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
    stub({
      getEffective: async (module: string) =>
        module === 'GRATUITY' && o.gratuityConfig
          ? { version: { isEnabled: true, config: o.gratuityConfig } }
          : module === 'BONUS' && o.bonusOn
            ? {
                version: {
                  isEnabled: true,
                  config: {
                    rate: 8.33,
                    eligibilityCeiling: 21000,
                    calculationCeiling: 7000,
                  },
                },
              }
            : { version: null },
    }),
    stub({ log: async (e: Row) => audit.push(e) }),
    stub({
      buildPayslipPdfBuffer: async () => ({
        buffer: Buffer.from('pdf'),
        filename: 'final.pdf',
      }),
    }),
  );
  return { service, settlements, audit, payrollService, unlinked, linked };
}

const admin = { id: 'admin', role: Role.ADMIN } as never;
const dto = (over: Row = {}) =>
  ({ employeeId: 'e1', lastWorkingDay: '2026-10-06', ...over }) as never;
// A leave type as the settlement sees it: active, with a real allocation and no eligibility restriction.
const leaveType = (over: Row = {}) => ({
  isActive: true,
  code: 'EL',
  allocationType: 'FIXED_ANNUAL',
  minServiceMonths: 0,
  maxServiceMonths: null,
  applicableDepartments: [],
  applicableEmployeeTypes: [],
  applicableGenders: [],
  encashment: { allowed: true },
  ...over,
});
const encashable = [leaveType({ id: 'lt1' })];

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('final settlement: the exit it belongs to', () => {
  it('is refused for a last working day other than the open offboarding case', async () => {
    const { service } = build({ openCase: { lastWorkingDay: '2026-10-08' } });
    await expect(service.calculate(dto(), admin, 'org')).rejects.toThrow(
      /offboarding case has last working day 08-10-2026/,
    );
  });
});

describe('final settlement: automatic link and system drafts', () => {
  it('a settlement figured for the exit\'s last working day is linked to the open offboarding case by itself', async () => {
    const { service, linked, settlements } = build({ openCase: { lastWorkingDay: '2026-10-08', createdAt: new Date('2026-09-01T00:00:00Z'), exitStatus: 'RELEASED', id: 'c1' } });
    await service.calculate(dto({ lastWorkingDay: '2026-10-08' }), admin, 'org');
    expect(linked).toHaveLength(1);
    expect(linked[0].data).toEqual({ settlementId: settlements[0].id });
    expect(linked[0].where).toMatchObject({ employeeId: 'e1', lastWorkingDay: '2026-10-08' });
  });

  it('a draft prepared by the system is recorded as calculated by nobody, so the reviewer satisfies maker-checker', async () => {
    const { service, settlements } = build();
    await service.calculate(dto(), admin, 'org', { system: true });
    expect(settlements[0].calculatedById).toBeNull();
    expect(settlements[0].processedById).toBeNull();
  });

  it('a draft calculated by a person records that person', async () => {
    const { service, settlements } = build();
    await service.calculate(dto(), admin, 'org');
    expect(settlements[0].calculatedById).toBe((admin as unknown as { id: string }).id);
  });
});

describe('final settlement: who can be settled', () => {
  it('someone whose account was closed before their settlement can still be settled', async () => {
    const left = build({
      employee: { id: 'e1', isActive: false, joiningDate: JOINED },
    });
    await expect(
      left.service.calculate(dto(), admin, 'org'),
    ).resolves.toBeDefined();
  });

  it('an unknown employee or a bad date is refused', async () => {
    await expect(
      build({ employee: null }).service.calculate(dto(), admin, 'org'),
    ).rejects.toThrow(/Employee not found/);
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
        recoveriesReason: 'Unreturned training bond',
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
        leaveType({ id: 'lt2' }),
        leaveType({ id: 'lt3', encashment: { allowed: false } }),
      ],
      leaveClosing: 3,
    });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.leaveEncashmentAmount).toBe(2 * 3 * 1000); // two encashable types x 3 days x 1,000
  });

  it('leave types the employee has no claim to are not paid: inactive, no allocation, or not eligible on the last working day', async () => {
    const { service } = build({
      basic: 30000,
      leaveTypes: [
        leaveType({ id: 'paid' }),
        leaveType({ id: 'inactive', isActive: false }),
        leaveType({ id: 'comp', code: 'COMPOFF' }),
        leaveType({ id: 'unlimited', allocationType: 'UNLIMITED' }),
        // Joined 7 Oct 2020; 6 years of service on the last working day, so a 100-month minimum is not met.
        leaveType({ id: 'newcomers', minServiceMonths: 100 }),
        leaveType({ id: 'women', applicableGenders: ['FEMALE'] }),
      ],
      leaveClosing: 3,
      employee: {
        id: 'e1',
        name: 'Asha',
        isActive: true,
        joiningDate: JOINED,
        employeeType: 'FULL_TIME',
        gender: 'MALE',
        departmentId: null,
      },
    });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.leaveEncashmentAmount).toBe(3 * 1000); // only the one type they qualify for
  });

  it('pays no leave while the company switch is off, and says how many days it left unpaid', async () => {
    const { service } = build({
      basic: 30000,
      leaveTypes: encashable,
      leaveClosing: 3,
      policies: { allowLeaveEncashment: false },
    });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.leaveEncashmentAmount).toBe(0);
    // No per-type days are recorded, so processing never takes days off a balance.
    expect(Array.isArray(s.leaveEncashmentDetail)).toBe(false);
    expect(s.warnings.join(' ')).toMatch(/turned off.*3 unused leave day/);
  });

  it('the bonus is taxed with the last month; leave encashment only beyond its s.10(10AA) exemption', async () => {
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
      // the 3000 encashment is within the s.10(10AA) exemption; only the bonus is taxed
      extraTaxableEarnings: 4000,
      monthAlreadyPaid: false,
      // the pending salary stops at the last working day
      lastWorkingDay: '2026-10-06',
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
      /owes the company/,
    );
    await expect(
      build().service.process('ghost', admin, 'org'),
    ).rejects.toThrow(/Settlement not found/);
  });

  it('a draft that still pays leave out is refused once the company switch has been turned off', async () => {
    const { service } = build({
      policies: { allowLeaveEncashment: false },
      settlements: [
        {
          id: 's1',
          employeeId: 'e1',
          status: 'DRAFT',
          netSettlementAmount: 5000,
          leaveEncashmentAmount: 3000,
          lastWorkingDay: '2026-10-06',
        },
      ],
    });
    await expect(service.process('s1', admin, 'org')).rejects.toThrow(
      /Leave encashment has been turned off.*Rs 3,000.*Recalculate/,
    );
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

describe('final settlement: discarding a draft', () => {
  it('deletes a draft, unlinks it from its exit case and audits it', async () => {
    const { service, settlements, audit, unlinked } = build({
      settlements: [
        {
          id: 's1',
          employeeId: 'e1',
          status: 'DRAFT',
          lastWorkingDay: '2026-10-06',
        },
      ],
    });
    await expect(service.discardDraft('s1', admin, 'org')).resolves.toEqual({
      id: 's1',
      discarded: true,
    });
    expect(settlements).toHaveLength(0);
    expect(unlinked).toEqual([{ organizationId: 'org', settlementId: 's1' }]);
    expect(audit.at(-1)).toMatchObject({
      action: 'SETTLEMENT_DISCARDED',
      targetId: 's1',
    });
  });

  it('never deletes a processed or paid settlement', async () => {
    for (const status of ['PROCESSED', 'PAID']) {
      const { service, settlements } = build({
        settlements: [{ id: 's1', employeeId: 'e1', status }],
      });
      await expect(service.discardDraft('s1', admin, 'org')).rejects.toThrow(
        /Only a draft settlement can be discarded/,
      );
      expect(settlements).toHaveLength(1);
    }
    await expect(
      build().service.discardDraft('ghost', admin, 'org'),
    ).rejects.toThrow(/Settlement not found/);
  });
});

describe('final settlement: notice period and recoveries', () => {
  const resignation = {
    status: 'APPROVED',
    submittedOn: '2026-09-21',
    noticePeriodDays: 30,
  };

  it('a resignation short of its notice is recovered automatically at the daily rate', async () => {
    // 30 days' notice given 21 Sep, leaving 6 Oct = 15 days served, 15 short; no run yet -> basic 30,000 / 30.
    const { service } = build({ basic: 30000, resignation });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.noticeShortfallDays).toBe(15);
    expect(s.noticePeriodRecovery).toBe(15000);
    expect(s.noticeRecoveryAuto).toBe(true);
    expect(s.netSettlementAmount).toBe(40000 - 15000);
  });

  it('an entered amount overrides it, and 0 waives it', async () => {
    const waived = await build({ basic: 30000, resignation }).service.calculate(
      dto({ noticePeriodRecovery: 0 }),
      admin,
      'org',
    );
    expect(waived.noticePeriodRecovery).toBe(0);
    expect(waived.noticeRecoveryAuto).toBe(false);
    const manual = await build({ basic: 30000, resignation }).service.calculate(
      dto({ noticePeriodRecovery: 2500 }),
      admin,
      'org',
    );
    expect(manual.noticePeriodRecovery).toBe(2500);
  });

  it('nothing is recovered when the full notice was served', async () => {
    const { service } = build({
      basic: 30000,
      resignation: { ...resignation, submittedOn: '2026-08-01' },
    });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.noticePeriodRecovery).toBe(0);
    expect(s.noticeShortfallDays).toBe(0);
  });

  it('a company-ended exit pays the shortfall as notice pay only when asked', async () => {
    const open = {
      id: 'c1',
      lastWorkingDay: '2026-10-06',
      exitStatus: 'TERMINATED',
      createdAt: new Date('2026-09-26T00:00:00Z'),
    };
    const { service } = build({
      basic: 30000,
      openCase: open,
      defaultNotice: 30,
    });
    // 30 days' company notice, 10 served (26 Sep to 6 Oct) -> 20 days x 30,000/30.
    const asked = await service.calculate(
      dto({ payNoticeInLieu: true }),
      admin,
      'org',
    );
    expect(asked.noticePayAmount).toBe(20000);
    expect(asked.noticePeriodRecovery).toBe(0);
    expect(asked.netSettlementAmount).toBe(40000 + 20000);
    const notAsked = await build({
      basic: 30000,
      openCase: open,
      defaultNotice: 30,
    }).service.calculate(dto(), admin, 'org');
    expect(notAsked.noticePayAmount).toBe(0);
  });

  it('recoveries need a stated reason', async () => {
    const { service } = build();
    await expect(
      service.calculate(dto({ recoveriesAmount: 500 }), admin, 'org'),
    ).rejects.toThrow(/recoveriesReason/);
  });

  it('with partial recovery the loan is limited to what is payable and the rest stays open', async () => {
    const { service } = build({
      loans: [{ outstandingBalance: 100000 }],
      calc: { netPay: 40000 },
    });
    const refused = await service.calculate(dto(), admin, 'org');
    expect(refused.netSettlementAmount).toBe(40000 - 100000);
    const partial = await build({
      loans: [{ outstandingBalance: 100000 }],
      calc: { netPay: 40000 },
    }).service.calculate(dto({ allowPartialLoanRecovery: true }), admin, 'org');
    expect(partial.loanBalanceRecovered).toBe(40000);
    expect(partial.loanBalanceUnrecovered).toBe(60000);
    expect(partial.netSettlementAmount).toBe(0);
  });
});

describe('final settlement: statutory bonus', () => {
  const run = (month: number) => ({
    month,
    year: month >= 4 ? 2026 : 2027,
    earnings: [{ code: 'BASIC', amount: 15000 }],
    attendanceSummary: { payableDays: 30, totalDaysInMonth: 30 },
  });
  const apr2sep = [4, 5, 6, 7, 8, 9].map(run);
  // October to the 6th: 6 of 31 days, basic earned in proportion
  const calc = {
    earnings: [{ code: 'BASIC', name: 'Basic', amount: 2903 }],
    attendanceSummary: { payableDays: 6, totalDaysInMonth: 31 },
  };

  it('is worked out for the year up to the exit and added when none was entered', async () => {
    const { service } = build({ bonusOn: true, signedRuns: apr2sep, calc });
    const s = await service.calculate(dto(), admin, 'org');
    // (6 x 7,000 + 7,000 x 6/31) x 8.33%
    expect(s.statutoryBonusDue).toBe(3611);
    expect(s.bonusAmount).toBe(3611);
    expect(s.bonusAuto).toBe(true);
    expect(s.warnings.join(' ')).toMatch(/Statutory bonus of 3611/);
  });

  it('is taxed with the last month', async () => {
    const { service, payrollService } = build({
      bonusOn: true,
      signedRuns: apr2sep,
      calc,
    });
    await service.calculate(dto(), admin, 'org');
    const calls = payrollService.calculatePayroll.mock.calls as unknown as [
      string,
      number,
      number,
      string,
      { finalSettlement: { extraTaxableEarnings: number } },
    ][];
    expect(calls.at(-1)![4].finalSettlement.extraTaxableEarnings).toBe(3611);
  });

  it('less the bonus the year already paid', async () => {
    const { service } = build({
      bonusOn: true,
      signedRuns: apr2sep,
      paidRuns: [{ earnings: [{ code: 'BONUS', amount: 1000 }] }],
      calc,
    });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.statutoryBonusPaid).toBe(1000);
    expect(s.bonusAmount).toBe(2611);
  });

  it("HR's own figure overrides it (0 pays none), and a disqualification calculates none", async () => {
    const own = await build({
      bonusOn: true,
      signedRuns: apr2sep,
      calc,
    }).service.calculate(dto({ bonusAmount: 0 }), admin, 'org');
    expect(own.bonusAmount).toBe(0);
    expect(own.bonusAuto).toBe(false);
    const dq = await build({
      bonusOn: true,
      signedRuns: apr2sep,
      calc,
    }).service.calculate(dto({ bonusDisqualified: true }), admin, 'org');
    expect(dq.bonusAmount).toBe(0);
    expect(dq.bonusDisqualified).toBe(true);
  });

  it('is nothing when the bonus module is off', async () => {
    const { service } = build({ signedRuns: apr2sep, calc });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.bonusAmount).toBe(0);
    expect(s.statutoryBonusDue).toBe(0);
  });
});

describe('final settlement: gratuity coverage', () => {
  const runs = [4, 5, 6, 7, 8, 9].map((m) => ({
    earnings: [{ code: 'BASIC', amount: 28000 }],
    month: m,
  }));

  it('a covered employer is paid by the Act and is fully exempt', async () => {
    const { service } = build({
      basic: 30000,
      gratuityConfig: { coverage: 'COVERED', payoutFormula: 'ACT' },
    });
    const s = await service.calculate(dto(), admin, 'org');
    // 30,000 x 15/26 x 6 completed years
    expect(s.gratuityAmount).toBe(103846);
    expect(s.gratuityTaxableAmount).toBe(0);
  });

  it('a non-covered employer paying half a month per year is exempt up to the same figure', async () => {
    const { service } = build({
      basic: 30000,
      signedRuns: runs,
      gratuityConfig: { coverage: 'NOT_COVERED', payoutFormula: 'HALF_MONTH' },
    });
    const s = await service.calculate(dto(), admin, 'org');
    // average 28,000 x 15/30 x 6
    expect(s.gratuityAmount).toBe(84000);
    expect(s.gratuityTaxableAmount).toBe(0);
  });

  it('a non-covered employer paying the Act figure voluntarily is taxed on the part above the exemption', async () => {
    const { service, payrollService } = build({
      basic: 30000,
      signedRuns: runs,
      gratuityConfig: { coverage: 'NOT_COVERED', payoutFormula: 'ACT' },
    });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.gratuityAmount).toBe(103846);
    // exempt = 28,000 x 15/30 x 6 = 84,000
    expect(s.gratuityTaxableAmount).toBe(103846 - 84000);
    expect(s.warnings.join(' ')).toMatch(/above its tax-exempt limit/);
    const calls = payrollService.calculatePayroll.mock.calls as unknown as [
      string,
      number,
      number,
      string,
      { finalSettlement: { extraTaxableEarnings: number } },
    ][];
    expect(calls.at(-1)![4].finalSettlement.extraTaxableEarnings).toBe(
      103846 - 84000,
    );
  });

  it("a non-covered employer's own minimum service applies, and a large headcount raises a warning", async () => {
    const { service } = build({
      basic: 30000,
      signedRuns: runs,
      headcount: 25,
      gratuityConfig: {
        coverage: 'NOT_COVERED',
        payoutFormula: 'HALF_MONTH',
        minimumServiceYears: 7,
      },
    });
    const s = await service.calculate(dto(), admin, 'org');
    expect(s.gratuityAmount).toBe(0); // 6 years < their own 7
    expect(s.warnings.join(' ')).toMatch(/25 active employees/);
  });
});
