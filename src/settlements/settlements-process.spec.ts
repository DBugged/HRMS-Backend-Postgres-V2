import { Role } from '@prisma/client';
import { SettlementsService } from './settlements.service';

type Row = Record<string, any>;

function build(
  o: {
    settlement?: Row | null;
    runs?: Row[];
    loans?: Row[];
    reimbursed?: number;
    reimbursementsPending?: Row[];
    pendingLeaves?: number;
    openEncashments?: number;
    completedExit?: boolean;
  } = {},
) {
  const settlement: Row | null =
    o.settlement === undefined
      ? {
          id: 's1',
          organizationId: 'org',
          employeeId: 'e1',
          status: 'DRAFT',
          lastWorkingDay: '2026-10-06',
          pendingSalaryAmount: 30000,
          pendingSalaryBreakdown: null,
          leaveEncashmentAmount: 6000,
          bonusAmount: 0,
          recoveriesAmount: 1000,
          loanBalanceRecovered: 5000,
          noticePeriodRecovery: 0,
          gratuityAmount: 90000,
          reimbursementAmount: 1500,
          netSettlementAmount: 121500,
          payrollRunId: null,
        }
      : o.settlement;
  const loans: Row[] = (o.loans ?? []).map((l) => ({ ...l }));
  const runs: Row[] = (o.runs ?? []).map((r) => ({ ...r }));
  const created: Row[] = [];
  const reimbursementUpdates: Row[] = [];
  const audit: Row[] = [];
  const notes: Row[] = [];
  const mails: Row[] = [];
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'organizationId') return true;
      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k]);
      return v === undefined || r[k] === v;
    });
  const settlementModel = {
    findFirst: async (a: Row) =>
      settlement && match(settlement, a?.where) ? { ...settlement } : null,
    findFirstOrThrow: async () => ({ ...settlement! }),
    updateMany: async (a: Row) => {
      if (!settlement || !match(settlement, a.where)) return { count: 0 };
      Object.assign(settlement, a.data);
      return { count: 1 };
    },
  };
  const payrollRun = {
    findFirst: async (a: Row) =>
      runs.find((r) => {
        if (a.where.isFinalSettlement === true)
          return r.isFinalSettlement === true;
        return (
          !r.isFinalSettlement &&
          (!a.where.status?.in || a.where.status.in.includes(r.status))
        );
      }) ?? null,
    create: async (a: Row) => {
      const row = { id: 'final-run', ...a.data };
      created.push(row);
      return row;
    },
    deleteMany: async (a: Row) => {
      const i = created.findIndex((c) => c.id === a.where.id);
      if (i >= 0) created.splice(i, 1);
      return { count: i >= 0 ? 1 : 0 };
    },
    updateMany: async (a: Row) => {
      const hit = created.find((c) => c.id === a.where.id);
      if (hit) Object.assign(hit, a.data);
      return { count: hit ? 1 : 0 };
    },
  };
  const loanModel = {
    findMany: async (a: Row) => loans.filter((l) => match(l, a?.where)),
    updateMany: async (a: Row) => {
      const hits = loans.filter((l) => match(l, a.where));
      hits.forEach((l) => Object.assign(l, a.data));
      return { count: hits.length };
    },
  };
  const reimbursement = {
    aggregate: async () => ({ _sum: { amount: o.reimbursed ?? 1500 } }),
    updateMany: async (a: Row) => {
      reimbursementUpdates.push(a);
      return { count: 1 };
    },
  };
  const tx: Row = {
    user: { findFirst: async () => ({ brandId: null }) },
    settlement: settlementModel,
    payrollRun,
    loan: loanModel,
    reimbursement,
  };
  const prisma: Row = {
    ...tx,
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    leave: { count: async () => o.pendingLeaves ?? 0 },
    leaveEncashment: { count: async () => o.openEncashments ?? 0 },
    offboardingCase: {
      findFirst: async () => (o.completedExit ? { id: 'c1' } : null),
    },
    user: {
      findFirst: async () => ({
        id: 'e1',
        name: 'Asha',
        email: 'login@x.com',
        personalData: { personalEmail: 'home@x.com' },
      }),
    },
    $transaction: async (cb: (t: Row) => unknown) => cb(tx),
  };
  const stub = <T>(x: T) => x as never;
  const service = new SettlementsService(
    stub(prisma),
    stub({}),
    stub({ getOrCreate: async () => ({ financialYearStartMonth: 4 }) }),
    stub({}),
    stub({}),
    stub({ create: async (n: Row) => notes.push(n) }),
    stub({ send: async (m: Row) => mails.push(m) }),
    stub({ logEvent: async () => undefined }),
    stub({ renderOccasion: async () => ({ subject: 's', html: 'h' }) }),
    stub({}),
    stub({ log: async (e: Row) => audit.push(e) }),
    stub({
      buildPayslipPdfBuffer: async () => ({
        buffer: Buffer.from('pdf'),
        filename: 'final.pdf',
      }),
    }),
  );
  return {
    service,
    settlement,
    loans,
    created,
    reimbursementUpdates,
    audit,
    notes,
    mails,
  };
}

const admin = { id: 'admin', role: Role.ADMIN } as never;
const activeLoan = {
  employeeId: 'e1',
  status: 'ACTIVE',
  outstandingBalance: 5000,
};

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('final settlement: processing it', () => {
  it('creates an Approved final-settlement payslip whose net pay is the settlement amount', async () => {
    const { service, created, settlement } = build({ loans: [activeLoan] });
    const r = await service.process('s1', admin, 'org');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      isFinalSettlement: true,
      status: 'APPROVED',
      month: 10,
      year: 2026,
      financialYear: '2026-27',
      netPay: 121500,
      approvedById: 'admin',
    });
    expect(settlement).toMatchObject({
      status: 'PROCESSED',
      payrollRunId: 'final-run',
    });
    expect(r.payrollRun.id).toBe('final-run');
  });

  it('the payslip lists pending salary, leave encashment, reimbursements and gratuity as earnings, and recoveries and the loan as deductions', async () => {
    const { service, created } = build({ loans: [activeLoan] });
    await service.process('s1', admin, 'org');
    const codes = (rows: Row[]) => rows.map((r) => `${r.code}:${r.amount}`);
    expect(codes(created[0].earnings)).toEqual([
      'PENDING_SALARY:30000',
      'LEAVE_ENCASHMENT:6000',
      'REIMBURSEMENT:1500',
      'GRATUITY:90000',
    ]);
    expect(codes(created[0].deductions)).toEqual([
      'RECOVERIES:1000',
      'LOAN_RECOVERY:5000',
    ]);
    expect(created[0].grossSalary).toBe(127500);
    expect(created[0].totalDeductions).toBe(6000);
  });

  it('gratuity and reimbursements are not taxable; the rest is', async () => {
    const { service, created } = build({ loans: [activeLoan] });
    await service.process('s1', admin, 'org');
    expect(created[0].taxableGross).toBe(36000);
  });

  it("closes the employee's active loans (their balance was recovered in full) and pays out approved reimbursements", async () => {
    const { service, loans, reimbursementUpdates } = build({
      loans: [activeLoan],
    });
    await service.process('s1', admin, 'org');
    expect(loans[0]).toMatchObject({ status: 'CLOSED', outstandingBalance: 0 });
    expect(reimbursementUpdates[0].data).toMatchObject({
      status: 'PAID',
      paymentMode: 'TRANSFER',
      payrollRunId: 'final-run',
    });
  });

  it('refuses when the loan balance changed since it was calculated, so an EMI is never taken twice', async () => {
    const { service, settlement } = build({
      loans: [{ ...activeLoan, outstandingBalance: 3000 }],
    });
    await expect(service.process('s1', admin, 'org')).rejects.toThrow(
      /Outstanding loan balance changed since this settlement was calculated \(5000 then, 3000 now\)/,
    );
    expect(settlement?.payrollRunId).toBeNull();
  });

  it('refuses when approved reimbursements changed since it was calculated', async () => {
    const { service } = build({ loans: [activeLoan], reimbursed: 2500 });
    await expect(service.process('s1', admin, 'org')).rejects.toThrow(
      /Approved reimbursements changed/,
    );
  });

  it('refuses when a regular run for the last month was locked after this was calculated and the settlement still pays that salary', async () => {
    const { service } = build({
      loans: [activeLoan],
      runs: [{ status: 'LOCKED', isFinalSettlement: false }],
    });
    await expect(service.process('s1', admin, 'org')).rejects.toThrow(
      /was locked after this settlement was calculated/,
    );
  });

  it('when that month was already paid the pending-salary line says so', async () => {
    const { service, created } = build({
      loans: [activeLoan],
      runs: [{ status: 'PAID', isFinalSettlement: false }],
      settlement: {
        id: 's1',
        organizationId: 'org',
        employeeId: 'e1',
        status: 'DRAFT',
        lastWorkingDay: '2026-10-06',
        pendingSalaryAmount: 0,
        pendingSalaryBreakdown: null,
        leaveEncashmentAmount: 0,
        bonusAmount: 0,
        recoveriesAmount: 0,
        loanBalanceRecovered: 5000,
        noticePeriodRecovery: 0,
        gratuityAmount: 0,
        reimbursementAmount: 1500,
        netSettlementAmount: -3500 + 3500 + 0,
      },
    });
    await service.process('s1', admin, 'org');
    expect(created[0].earnings[0].name).toMatch(
      /already paid in 10\/2026 payroll/,
    );
  });

  it('an open regular run for the last month blocks it', async () => {
    const { service } = build({
      loans: [activeLoan],
      runs: [{ status: 'CALCULATED', isFinalSettlement: false }],
    });
    await expect(service.process('s1', admin, 'org')).rejects.toThrow(
      /CALCULATED but not locked/i,
    );
  });

  it('is audited, and the employee is told on their personal e-mail, not the login one', async () => {
    const { service, audit, notes, mails } = build({ loans: [activeLoan] });
    await service.process('s1', admin, 'org');
    expect(audit.at(-1)).toMatchObject({
      action: 'SETTLEMENT_PROCESSED',
      details: { netSettlementAmount: 121500 },
    });
    expect(notes[0].title).toBe('Full & Final Settlement Processed');
    expect(mails[0].to).toBe('home@x.com');
  });

  it('processing it a second time is refused', async () => {
    const { service } = build({ loans: [activeLoan] });
    await service.process('s1', admin, 'org');
    await expect(service.process('s1', admin, 'org')).rejects.toThrow(
      /Only a draft settlement can be processed/,
    );
  });
});

describe('final settlement: marking it paid', () => {
  const processed = (over: Row = {}) => ({
    id: 's1',
    organizationId: 'org',
    employeeId: 'e1',
    status: 'PROCESSED',
    payrollRunId: 'final-run',
    netSettlementAmount: 100,
    gratuityAmount: 0,
    lastWorkingDay: '2026-10-06',
    updatedAt: new Date(),
    ...over,
  });

  it('marks the settlement and its payslip as paid', async () => {
    const { service, created, settlement } = build({ settlement: processed() });
    created.push({ id: 'final-run', status: 'APPROVED' });
    await service.markPaid('s1', admin, 'org');
    expect(settlement?.status).toBe('PAID');
    expect(created[0]).toMatchObject({ status: 'PAID', paidById: 'admin' });
  });

  it('only a processed settlement can be marked paid, and not twice', async () => {
    const draft = build();
    await expect(draft.service.markPaid('s1', admin, 'org')).rejects.toThrow(
      /must be processed before it can be marked paid/,
    );
    const done = build({ settlement: processed({ status: 'PAID' }) });
    await expect(done.service.markPaid('s1', admin, 'org')).rejects.toThrow(
      /must be processed/,
    );
    await expect(
      build({ settlement: null }).service.markPaid('ghost', admin, 'org'),
    ).rejects.toThrow(/must be processed/);
  });

  it('records when, how and under which reference it was paid', async () => {
    const { service, settlement } = build({ settlement: processed() });
    await service.markPaid('s1', admin, 'org', {
      paidOn: '2026-10-08',
      paymentMode: 'BANK_TRANSFER',
      paymentReference: 'UTR123',
    });
    expect(settlement).toMatchObject({
      status: 'PAID',
      paidById: 'admin',
      paymentMode: 'BANK_TRANSFER',
      paymentReference: 'UTR123',
    });
    expect((settlement?.paidAt as Date).toISOString().slice(0, 10)).toBe(
      '2026-10-08',
    );
  });

  it('a payment date in the future or before the last working day is refused', async () => {
    const { service } = build({ settlement: processed() });
    await expect(
      service.markPaid('s1', admin, 'org', { paidOn: '2099-01-01' }),
    ).rejects.toThrow(/future/);
    await expect(
      service.markPaid('s1', admin, 'org', { paidOn: '2026-10-01' }),
    ).rejects.toThrow(/before the last working day/);
  });

  it('emails the final payslip / settlement statement to the personal address once paid', async () => {
    const { service, mails } = build({ settlement: processed() });
    await service.markPaid('s1', admin, 'org');
    // The send is fire-and-forget; let its promise chain settle (fake timers are on in this file).
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'home@x.com' });
    expect(mails[0].attachments).toHaveLength(1);
    expect(mails[0].attachments[0].filename).toBe('final.pdf');
  });

  it('is audited', async () => {
    const { service, audit } = build({ settlement: processed() });
    await service.markPaid('s1', admin, 'org');
    expect(audit.at(-1)).toMatchObject({
      action: 'SETTLEMENT_PAID',
      details: { netSettlementAmount: 100 },
    });
  });
});

describe('final settlement: maker-checker', () => {
  const draft = { calculatedById: 'hr1' } as Row;
  const base = {
    id: 's1',
    organizationId: 'org',
    employeeId: 'e1',
    status: 'DRAFT',
    lastWorkingDay: '2026-10-06',
    pendingSalaryAmount: 0,
    pendingSalaryBreakdown: null,
    leaveEncashmentAmount: 0,
    bonusAmount: 0,
    recoveriesAmount: 0,
    loanBalanceRecovered: 0,
    noticePeriodRecovery: 0,
    gratuityAmount: 0,
    reimbursementAmount: 0,
    netSettlementAmount: 100,
    payrollRunId: null,
    ...draft,
  };

  it('HR cannot process the settlement they calculated, another HR user can', async () => {
    const hr1 = { id: 'hr1', role: Role.HR } as never;
    const hr2 = { id: 'hr2', role: Role.HR } as never;
    await expect(
      build({ settlement: { ...base }, reimbursed: 0 }).service.process(
        's1',
        hr1,
        'org',
      ),
    ).rejects.toThrow(/someone other than the person who calculated/);
    const ok = build({ settlement: { ...base }, reimbursed: 0 });
    await ok.service.process('s1', hr2, 'org');
    expect(ok.created[0]).toMatchObject({
      verifiedById: 'hr1',
      approvedById: 'hr2',
    });
  });

  it('an Admin may process their own calculation', async () => {
    const own = build({
      settlement: { ...base, calculatedById: 'admin' },
      reimbursed: 0,
    });
    await own.service.process('s1', admin, 'org');
    expect(own.settlement?.status).toBe('PROCESSED');
  });
});

describe('final settlement: pending leave and reversal', () => {
  it('is not processed while leave applications or encashment requests are undecided', async () => {
    const a = build({ loans: [activeLoan], pendingLeaves: 1 });
    await expect(a.service.process('s1', admin, 'org')).rejects.toThrow(
      /1 pending leave application/,
    );
    const b = build({ loans: [activeLoan], openEncashments: 2 });
    await expect(b.service.process('s1', admin, 'org')).rejects.toThrow(
      /2 leave encashment request/,
    );
  });

  it('reversing reopens the loans, removes the final payslip run and returns to draft', async () => {
    const r = build({
      loans: [
        { id: 'l1', employeeId: 'e1', status: 'CLOSED', outstandingBalance: 0 },
      ],
      settlement: {
        id: 's1',
        organizationId: 'org',
        employeeId: 'e1',
        status: 'PROCESSED',
        lastWorkingDay: '2026-10-06',
        payrollRunId: 'final-run',
        loanBalanceRecovered: 5000,
        closedLoans: [{ id: 'l1', outstandingBalance: 5000 }],
        leaveEncashmentDetail: null,
      },
    });
    r.created.push({ id: 'final-run', isFinalSettlement: true });
    await r.service.reverse('s1', { reason: 'LWD was wrong' }, admin, 'org');
    expect(r.settlement).toMatchObject({
      status: 'DRAFT',
      payrollRunId: null,
      reversedById: 'admin',
    });
    expect(r.loans[0]).toMatchObject({
      status: 'ACTIVE',
      outstandingBalance: 5000,
    });
    expect(r.created).toHaveLength(0);
    expect(r.audit.at(-1)).toMatchObject({ action: 'SETTLEMENT_REVERSED' });
  });

  it('only a processed, unpaid settlement of an exit that is not completed can be reversed', async () => {
    const draft = build();
    await expect(
      draft.service.reverse('s1', { reason: 'wrong LWD' }, admin, 'org'),
    ).rejects.toThrow(/Only a processed settlement/);
    const paid = build({
      settlement: {
        id: 's1',
        organizationId: 'org',
        employeeId: 'e1',
        status: 'PAID',
        lastWorkingDay: '2026-10-06',
      },
    });
    await expect(
      paid.service.reverse('s1', { reason: 'wrong LWD' }, admin, 'org'),
    ).rejects.toThrow(/already been paid/);
    const done = build({
      completedExit: true,
      settlement: {
        id: 's1',
        organizationId: 'org',
        employeeId: 'e1',
        status: 'PROCESSED',
        lastWorkingDay: '2026-10-06',
        loanBalanceRecovered: 0,
      },
    });
    await expect(
      done.service.reverse('s1', { reason: 'wrong LWD' }, admin, 'org'),
    ).rejects.toThrow(/exit has been completed/);
  });
});
