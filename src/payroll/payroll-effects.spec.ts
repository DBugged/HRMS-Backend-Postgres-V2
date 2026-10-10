import { Role } from '@prisma/client';
import { PayrollService } from './payroll.service';

type Row = Record<string, any>;

interface World {
  runs: Row[];
  loans?: Row[];
  repayments?: Row[];
  encashments?: Row[];
  employees?: Row[];
  audit?: Row[];
}

function build(
  w: World,
  opts: { queue?: boolean; recordFails?: boolean } = {},
) {
  const runs = w.runs.map((r) => ({
    organizationId: 'org',
    isFinalSettlement: false,
    ...r,
  }));
  const loans = (w.loans ?? []).map((l) => ({ organizationId: 'org', ...l }));
  const repayments = (w.repayments ?? []).map((r) => ({
    organizationId: 'org',
    createdAt: new Date(),
    ...r,
  }));
  const encashments = (w.encashments ?? []).map((e) => ({
    organizationId: 'org',
    ...e,
  }));
  const employees = w.employees ?? [
    { id: 'emp', name: 'Asha', email: 'a@x.com' },
  ];
  const auditLogs: Row[] = (w.audit ?? []).map((a) => ({
    organizationId: 'org',
    module: 'PAYROLL',
    createdAt: new Date(),
    ...a,
  }));
  const audit: Row[] = [];
  const notes: Row[] = [];
  const mails: Row[] = [];
  const queued: Row[] = [];
  const recorded: Row[] = [];
  const match = (r: Row, wh: Row = {}) =>
    Object.entries(wh).every(([k, v]) => {
      if (k === 'organizationId' || k === 'OR' || k === 'orderBy') return true;
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(r[k]);
        if ('not' in v) return r[k] !== v.not;
        if ('gt' in v) return r[k] > v.gt;
      }
      return v === undefined || r[k] === v;
    });
  const apply = (rows: Row[], a: Row) => {
    const hits = rows.filter((r) => match(r, a.where));
    hits.forEach((r) => Object.assign(r, a.data));
    return { count: hits.length };
  };
  const model = (rows: Row[]) => ({
    findMany: async (a: Row) =>
      rows.filter((r) => match(r, a?.where)).map((r) => ({ ...r })),
    findFirst: async (a: Row) => {
      let hits = rows.filter((r) => match(r, a?.where));
      if (a?.orderBy?.createdAt === 'desc')
        hits = [...hits].sort((x, y) => y.createdAt - x.createdAt);
      return hits[0] ? { ...hits[0] } : null;
    },
    findFirstOrThrow: async (a: Row) => ({
      ...rows.find((r) => match(r, a?.where))!,
    }),
    updateMany: async (a: Row) => apply(rows, a),
    deleteMany: async (a: Row) => {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--)
        if (match(rows[i], a.where)) {
          rows.splice(i, 1);
          n++;
        }
      return { count: n };
    },
  });
  const tx = { loan: model(loans), loanRepayment: model(repayments) };
  const prisma: Row = new Proxy(
    {
      payrollRun: model(runs),
      loan: model(loans),
      loanRepayment: model(repayments),
      leaveEncashment: model(encashments),
      auditLog: {
        findMany: async (a: Row) =>
          auditLogs.filter((l) =>
            a.where.action?.in ? a.where.action.in.includes(l.action) : true,
          ),
      },
      user: {
        findFirst: async (a: Row) =>
          employees.find((e) => e.id === a?.where?.id) ?? null,
      },
      organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
      $transaction: async (arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (t: Row) => unknown)(tx)
          : Promise.all(arg as Promise<unknown>[]),
    } as Row,
    {
      get: (t, p: string) =>
        t[p] ?? {
          findMany: async () => [],
          findFirst: async () => null,
          updateMany: async () => ({ count: 0 }),
          count: async () => 0,
        },
    },
  );
  const stub = <T>(x: T) => x as never;
  const service = new PayrollService(
    stub(prisma),
    stub({}),
    stub({}),
    stub({ log: async (e: Row) => audit.push(e) }),
    stub({ logEvent: async () => undefined }),
    stub({
      buildPayslipPdfBuffer: async () => ({
        buffer: Buffer.from('%PDF'),
        filename: 'payslip.pdf',
      }),
    }),
    stub({ create: async (n: Row) => notes.push(n) }),
    stub({ send: async (m: Row) => mails.push(m) }),
    stub({
      enqueue: async (j: Row) => (opts.queue ? (queued.push(j), true) : false),
    }),
    stub({
      renderOccasion: async () => ({ subject: 'Payslip', html: '<p>hi</p>' }),
    }),
    stub({
      recordRepayment: async (loanId: string, dto: Row) => {
        if (opts.recordFails) throw new Error('loan service down');
        recorded.push({ loanId, ...dto });
        const loan = loans.find((l) => l.id === loanId)!;
        loan.outstandingBalance -= dto.amount;
        if (loan.outstandingBalance <= 0) loan.status = 'CLOSED';
        repayments.push({
          id: `rep${repayments.length + 1}`,
          organizationId: 'org',
          loanId,
          payrollRunId: dto.payrollRun,
          month: dto.month,
          year: dto.year,
          amount: dto.amount,
          principalComponent: dto.amount,
          createdAt: new Date(),
        });
      },
    }),
  );
  return {
    service,
    runs,
    loans,
    repayments,
    encashments,
    audit,
    notes,
    mails,
    queued,
    recorded,
  };
}

const run = (over: Row = {}): Row => ({
  id: 'r1',
  employeeId: 'emp',
  month: 9,
  year: 2026,
  status: 'APPROVED',
  grossSalary: 42000,
  netPay: 37000,
  totalDeductions: 5000,
  totalEmployerContributions: 0,
  ctcMonthly: 42000,
  taxableGross: 42000,
  earnings: [{ code: 'BASIC', name: 'Basic', amount: 42000 }],
  deductions: [],
  employerContributions: [],
  calculatedById: 'c',
  ...over,
});
const admin = { id: 'admin', role: Role.ADMIN } as never;
const hr = { id: 'hr1', role: Role.HR } as never;

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('payroll lock: what it settles', () => {
  const emiRun = () =>
    run({
      deductions: [
        {
          code: 'LOAN_EMI',
          name: 'Loan EMI',
          amount: 5000,
          sourceIds: ['loan1'],
        },
      ],
    });
  const loan = (over: Row = {}) => ({
    id: 'loan1',
    employeeId: 'emp',
    status: 'ACTIVE',
    outstandingBalance: 20000,
    interestRate: 0,
    ...over,
  });

  it('a leave encashment on the payslip becomes Processed and is tied to this run', async () => {
    const { service, encashments } = build({
      runs: [
        run({
          earnings: [
            {
              code: 'LEAVE_ENCASHMENT',
              name: 'Encashment',
              amount: 3000,
              sourceIds: ['en1'],
            },
          ],
        }),
      ],
      encashments: [
        { id: 'en1', employeeId: 'emp', status: 'APPROVED', amount: 3000 },
        { id: 'en2', employeeId: 'emp', status: 'APPROVED', amount: 9999 }, // approved later, not on this payslip
      ],
    });
    await service.lock('r1', admin, 'org');
    expect(encashments.find((e) => e.id === 'en1')).toMatchObject({
      status: 'PROCESSED',
      payrollRunId: 'r1',
    });
    expect(encashments.find((e) => e.id === 'en2')?.status).toBe('APPROVED');
  });

  it('the loan EMI on the payslip is charged against the loan at lock, and not before', async () => {
    const { service, loans, recorded } = build({
      runs: [emiRun()],
      loans: [loan()],
    });
    expect(loans[0].outstandingBalance).toBe(20000);
    await service.lock('r1', admin, 'org');
    expect(recorded).toEqual([
      expect.objectContaining({
        loanId: 'loan1',
        amount: 5000,
        month: 9,
        year: 2026,
        payrollRun: 'r1',
      }),
    ]);
    expect(loans[0].outstandingBalance).toBe(15000);
  });

  it('locking the same run again never charges the same EMI twice', async () => {
    const { service, recorded, runs } = build({
      runs: [emiRun()],
      loans: [loan()],
    });
    await service.lock('r1', admin, 'org');
    runs[0].status = 'APPROVED'; // as if unlocked and approved again without the reversal landing
    await service.lock('r1', admin, 'org');
    expect(recorded).toHaveLength(1);
  });

  it('paying the last EMI closes the loan', async () => {
    const { service, loans } = build({
      runs: [emiRun()],
      loans: [loan({ outstandingBalance: 5000 })],
    });
    await service.lock('r1', admin, 'org');
    expect(loans[0]).toMatchObject({ outstandingBalance: 0, status: 'CLOSED' });
  });

  it('if applying those effects fails, the run goes back to Approved and the user is told to lock again', async () => {
    const { service, runs } = build(
      { runs: [emiRun()], loans: [loan()] },
      { recordFails: true },
    );
    await expect(service.lock('r1', admin, 'org')).rejects.toThrow(
      /failed while applying its loan\/encashment effects.*moved back to Approved/s,
    );
    expect(runs[0].status).toBe('APPROVED');
    expect(runs[0].lockedAt ?? null).toBeNull();
  });
});

describe('payroll unlock: taking it all back', () => {
  const locked = (over: Row = {}) => run({ status: 'LOCKED', ...over });

  it('puts the loan balance back, removes the EMI record and reopens a loan the EMI had closed', async () => {
    const { service, loans, repayments, audit } = build({
      runs: [locked()],
      loans: [
        {
          id: 'loan1',
          employeeId: 'emp',
          status: 'CLOSED',
          outstandingBalance: 0,
        },
      ],
      repayments: [
        {
          id: 'rep1',
          loanId: 'loan1',
          payrollRunId: 'r1',
          principalComponent: 5000,
          amount: 5000,
          month: 9,
          year: 2026,
        },
      ],
    });
    await service.unlock(
      'r1',
      { reason: 'wrong attendance' } as never,
      admin,
      'org',
    );
    expect(loans[0]).toMatchObject({
      outstandingBalance: 5000,
      status: 'ACTIVE',
    });
    expect(repayments).toHaveLength(0);
    expect(audit.some((a) => a.action === 'LOAN_REPAYMENT_REVERSED')).toBe(
      true,
    );
  });

  it('a processed leave encashment goes back to Approved so the recalculated run pays it again', async () => {
    const { service, encashments } = build({
      runs: [locked()],
      encashments: [
        {
          id: 'en1',
          employeeId: 'emp',
          status: 'PROCESSED',
          payrollRunId: 'r1',
        },
      ],
    });
    await service.unlock('r1', { reason: 'fix' } as never, admin, 'org');
    expect(encashments[0]).toMatchObject({
      status: 'APPROVED',
      payrollRunId: null,
    });
  });

  it('is refused when a later EMI was already taken on the same loan', async () => {
    const { service, runs } = build({
      runs: [locked()],
      loans: [
        {
          id: 'loan1',
          employeeId: 'emp',
          status: 'ACTIVE',
          outstandingBalance: 10000,
        },
      ],
      repayments: [
        {
          id: 'rep1',
          loanId: 'loan1',
          payrollRunId: 'r1',
          principalComponent: 5000,
          amount: 5000,
          month: 9,
          year: 2026,
          createdAt: new Date('2026-09-30'),
        },
        {
          id: 'rep2',
          loanId: 'loan1',
          payrollRunId: 'r2',
          principalComponent: 5000,
          amount: 5000,
          month: 10,
          year: 2026,
          createdAt: new Date('2026-10-05'),
        },
      ],
    });
    await expect(
      service.unlock('r1', { reason: 'fix' } as never, admin, 'org'),
    ).rejects.toThrow(/cannot be unlocked.*Unlock the later payroll first/s);
    expect(runs[0].status).toBe('LOCKED');
  });

  it('a payslip the employee already received is withdrawn with a notification', async () => {
    const { service, notes } = build({ runs: [locked({ status: 'PAID' })] });
    await service.unlock('r1', { reason: 'wrong tax' } as never, admin, 'org');
    expect(notes.at(-1)?.title).toBe('Payslip for 9/2026 withdrawn');
  });

  it('an unlock that never reached the employee sends nothing', async () => {
    const { service, notes } = build({ runs: [locked()] });
    await service.unlock('r1', { reason: 'fix' } as never, admin, 'org');
    expect(notes).toHaveLength(0);
  });
});

describe('payroll pay: telling the employee', () => {
  it('sends an in-app note and queues the payslip e-mail when the queue is configured', async () => {
    const { service, notes, queued, mails } = build(
      { runs: [run({ status: 'LOCKED' })] },
      { queue: true },
    );
    await service.pay('r1', hr, 'org');
    expect(notes[0]).toMatchObject({
      userId: 'emp',
      title: 'Payslip for 9/2026',
    });
    expect(notes[0].message).toMatch(/has been paid. Net pay: 37000/);
    expect(queued).toEqual([{ runId: 'r1', organizationId: 'org' }]);
    expect(mails).toHaveLength(0);
  });

  it('without a queue the payslip PDF is attached and the e-mail goes out straight away, once', async () => {
    const { service, mails, runs } = build(
      { runs: [run({ status: 'LOCKED' })] },
      { queue: false },
    );
    await service.pay('r1', hr, 'org');
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      to: 'a@x.com',
      attachments: [{ filename: 'payslip.pdf' }],
    });
    expect(runs[0].payslipEmailSentAt).toBeInstanceOf(Date);
  });

  it('a corrected payslip is announced as revised', async () => {
    const { service, notes } = build(
      { runs: [run({ status: 'LOCKED', unlockedAt: new Date('2026-10-01') })] },
      { queue: true },
    );
    await service.pay('r1', hr, 'org');
    expect(notes[0].title).toBe('Revised payslip for 9/2026');
  });

  it('a payslip already delivered is not sent again', async () => {
    const { service, notes } = build(
      { runs: [run({ status: 'LOCKED', payslipEmailSentAt: new Date() })] },
      { queue: true },
    );
    await service.pay('r1', hr, 'org');
    expect(notes).toHaveLength(0);
  });
});

describe('payroll: who can read which payslip', () => {
  const rows = [
    run({ id: 'a', employeeId: 'emp', status: 'DRAFT' }),
    run({ id: 'b', employeeId: 'emp', status: 'CALCULATED' }),
    run({ id: 'c', employeeId: 'emp', status: 'APPROVED' }),
    run({ id: 'd', employeeId: 'emp', status: 'PAID', month: 8 }),
    run({ id: 'e', employeeId: 'other', status: 'PAID' }),
  ];
  const ids = async (p: Promise<unknown>) =>
    ((await p) as { data: Row[] }).data.map((r) => r.id).sort();
  const q = (over: Row = {}) => ({ page: 1, limit: 50, ...over }) as never;

  const wrap = () => {
    const b = build({ runs: rows });
    // the list endpoints include the employee relation and paginate; give the fake the bits they use
    (b.service as never as Row).scopedPrisma.payrollRun.count = async () =>
      rows.length;
    return b;
  };

  it('an employee sees only their own payslips, and only once they are Approved, Locked or Paid', async () => {
    const { service } = wrap();
    const me = { id: 'emp', role: Role.EMPLOYEE } as never;
    expect(await ids(service.findAll(q(), me, 'org'))).toEqual(['c', 'd']);
  });

  it("a manager is treated the same way: never their reports' payslips", async () => {
    const { service } = wrap();
    const mgr = { id: 'emp', role: Role.MANAGER } as never;
    expect(await ids(service.findAll(q(), mgr, 'org'))).toEqual(['c', 'd']);
    expect(
      await ids(service.findAll(q({ employeeId: 'other' }), mgr, 'org')),
    ).toEqual(['c', 'd']);
  });

  it('HR sees every status, and can narrow by employee', async () => {
    const { service } = wrap();
    expect(await ids(service.findAll(q(), hr, 'org'))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(
      await ids(service.findAll(q({ employeeId: 'other' }), hr, 'org')),
    ).toEqual(['e']);
  });

  it("one payslip: your own is readable, someone else's is forbidden, an unfinished one does not exist for you", async () => {
    const { service } = wrap();
    const me = { id: 'emp', role: Role.EMPLOYEE } as never;
    expect((await service.findOne('c', me, 'org')).id).toBe('c');
    await expect(service.findOne('e', me, 'org')).rejects.toThrow(
      /Not authorized/,
    );
    await expect(service.findOne('b', me, 'org')).rejects.toThrow(
      /Payslip not found/,
    );
    await expect(service.findOne('ghost', me, 'org')).rejects.toThrow(
      /Payslip not found/,
    );
    expect((await service.findOne('b', hr, 'org')).id).toBe('b');
  });
});

describe('payroll history', () => {
  it('lists the payroll actions newest first with the run each one was about', async () => {
    const { service } = build({
      runs: [run()],
      audit: [
        {
          id: 'l1',
          action: 'PAYROLL_APPROVED',
          targetId: 'r1',
          actor: { name: 'HR' },
        },
        { id: 'l2', action: 'LEAVE_APPROVED', targetId: 'x' }, // not a payroll action
      ],
    });
    const r = await service.getHistory({} as never, hr, 'org');
    expect(r.history.map((h: Row) => h.action)).toEqual(['PAYROLL_APPROVED']);
    expect(r.history[0].run).toMatchObject({ id: 'r1' });
  });
});
