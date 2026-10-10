import { LoanStatus, LoanType, Role } from '@prisma/client';
import { LoansService } from './loans.service';

type Row = Record<string, any>;

const EMP = (over: Row = {}): Row => ({
  id: 'e1',
  organizationId: 'org',
  name: 'Asha',
  email: 'a@x.com',
  role: Role.EMPLOYEE,
  isActive: true,
  ...over,
});

function build(
  opts: {
    employee?: Row | null;
    loans?: Row[];
    runs?: Row[];
    components?: Row[];
    repayments?: Row[];
  } = {},
) {
  const loans: Row[] = (opts.loans ?? []).map((l) => ({ ...l }));
  const repayments: Row[] = (opts.repayments ?? []).map((r) => ({ ...r }));
  const audit: Row[] = [];
  const notes: Row[] = [];
  let seq = 0;
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'organizationId') return true;
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('gt' in v) return r[k] > v.gt;
        if ('not' in v) return r[k] !== v.not;
        if ('in' in v) return v.in.includes(r[k]);
      }
      return v === undefined || r[k] === v;
    });
  const employee = opts.employee === undefined ? EMP() : opts.employee;
  const loanModel = {
    findFirst: async (a: Row) => {
      const l = loans.find((x) => match(x, a?.where));
      return l ? { ...l } : null;
    },
    findFirstOrThrow: async (a: Row) => {
      const l = loans.find((x) => match(x, a?.where));
      if (!l) throw new Error('nf');
      return { ...l };
    },
    findMany: async (a: Row) => loans.filter((l) => match(l, a?.where)),
    create: async (a: Row) => {
      const row = { id: `loan${++seq}`, ...a.data };
      loans.push(row);
      return row;
    },
    updateMany: async (a: Row) => {
      const hits = loans.filter((l) => match(l, a.where));
      hits.forEach((l) => Object.assign(l, a.data));
      return { count: hits.length };
    },
  };
  const repaymentModel = {
    findFirst: async (a: Row) =>
      repayments.find((r) => match(r, a?.where)) ?? null,
    findMany: async (a: Row) => repayments.filter((r) => match(r, a?.where)),
    create: async (a: Row) => {
      const row = { id: `rep${++seq}`, ...a.data };
      repayments.push(row);
      return row;
    },
  };
  const prisma: Row = {
    user: {
      findFirst: async () => employee,
      findMany: async () => [{ id: 'hr1' }],
    },
    loan: loanModel,
    loanRepayment: repaymentModel,
    payrollRun: { findMany: async () => opts.runs ?? [] },
    employeeSalaryComponent: { findMany: async () => opts.components ?? [] },
    $transaction: async (cb: (tx: Row) => unknown) =>
      cb({ loan: loanModel, loanRepayment: repaymentModel }),
  };
  const stub = <T>(x: T) => x as never;
  const service = new LoansService(
    stub(prisma),
    stub({
      create: async (n: Row) => notes.push(n),
      createMany: async () => undefined,
    }),
    stub({ send: async () => undefined }),
    stub({
      log: async (e: Row) => audit.push(e),
      logSelfApproval: async () => undefined,
    }),
    stub({ logEvent: async () => undefined }),
    stub({ renderOccasion: async () => ({ subject: 's', html: 'h' }) }),
  );
  return { service, loans, repayments, audit, notes };
}

const admin = { id: 'admin', role: Role.ADMIN, name: 'Admin' } as never;
const hr = { id: 'hr1', role: Role.HR, name: 'HR' } as never;
const now = new Date();
const thisMonth = {
  startMonth: now.getUTCMonth() + 1,
  startYear: now.getUTCFullYear(),
};
// A previous payroll run gives the employee a take-home of 50,000.
const salary = [{ netPay: 50000, deductions: [] }];

describe('loans: sanctioning', () => {
  it('computes the EMI and sets the outstanding balance to the principal', async () => {
    const { service, loans } = build({ runs: salary });
    const loan = await service.create(
      {
        employeeId: 'e1',
        loanType: LoanType.LOAN,
        principal: 120000,
        interestRate: 0,
        tenureMonths: 12,
        ...thisMonth,
      } as never,
      admin,
      'org',
    );
    expect(loan.emiAmount).toBe(10000);
    expect(loan.outstandingBalance).toBe(120000);
    expect(loans).toHaveLength(1);
  });

  it('uses the reducing-balance formula when there is interest (100,000 at 12% over 12 months = 8,885)', async () => {
    const { service } = build({ runs: salary });
    const loan = await service.create(
      {
        employeeId: 'e1',
        loanType: LoanType.LOAN,
        principal: 100000,
        interestRate: 12,
        tenureMonths: 12,
        ...thisMonth,
      } as never,
      admin,
      'org',
    );
    expect(loan.emiAmount).toBe(8885);
  });

  it('a salary advance cannot carry interest', async () => {
    const { service } = build({ runs: salary });
    await expect(
      service.create(
        {
          employeeId: 'e1',
          loanType: LoanType.ADVANCE,
          principal: 10000,
          interestRate: 5,
          tenureMonths: 2,
          ...thisMonth,
        } as never,
        admin,
        'org',
      ),
    ).rejects.toThrow(/interest-free/);
  });

  it('refuses an unknown or deactivated employee', async () => {
    const none = build({ employee: null });
    await expect(
      none.service.create(
        {
          employeeId: 'x',
          principal: 1000,
          tenureMonths: 2,
          ...thisMonth,
        } as never,
        admin,
        'org',
      ),
    ).rejects.toThrow(/Employee not found/);
    const off = build({ employee: EMP({ isActive: false }) });
    await expect(
      off.service.create(
        {
          employeeId: 'e1',
          principal: 1000,
          tenureMonths: 2,
          ...thisMonth,
        } as never,
        admin,
        'org',
      ),
    ).rejects.toThrow(/deactivated employee/);
  });

  it('the total EMI may not exceed 30% of net monthly salary', async () => {
    const { service } = build({ runs: salary }); // net 50,000 -> limit 15,000
    await expect(
      service.create(
        {
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 200000,
          interestRate: 0,
          tenureMonths: 12,
          ...thisMonth,
        } as never, // EMI 16,667
        admin,
        'org',
      ),
    ).rejects.toThrow(/above the 30% limit/);
    const ok = build({ runs: salary });
    await expect(
      ok.service.create(
        {
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 180000,
          interestRate: 0,
          tenureMonths: 12,
          ...thisMonth,
        } as never, // EMI 15,000
        admin,
        'org',
      ),
    ).resolves.toBeTruthy();
  });

  it('EMIs of loans already running count towards the 30% cap', async () => {
    const { service } = build({
      runs: salary,
      loans: [
        {
          id: 'old',
          employeeId: 'e1',
          status: LoanStatus.ACTIVE,
          outstandingBalance: 10000,
          emiAmount: 10000,
        },
      ],
    });
    await expect(
      service.create(
        {
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 72000,
          interestRate: 0,
          tenureMonths: 12,
          ...thisMonth,
        } as never, // +6,000 = 16,000
        admin,
        'org',
      ),
    ).rejects.toThrow(/above the 30% limit/);
  });

  it('the cap is judged on take-home with any loan EMI added back, best of the last three months', async () => {
    const { service } = build({
      runs: [
        { netPay: 35000, deductions: [{ code: 'LOAN_EMI', amount: 15000 }] }, // 50,000 before the EMI
        { netPay: 20000, deductions: [] },
      ],
    });
    await expect(
      service.create(
        {
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 180000,
          interestRate: 0,
          tenureMonths: 12,
          ...thisMonth,
        } as never,
        admin,
        'org',
      ),
    ).resolves.toBeTruthy();
  });

  it('with no payroll yet, the fixed earnings of the salary structure are the base', async () => {
    const row = (code: string, amount: number) => ({
      componentCode: code,
      valueType: 'FIXED',
      fixedAmount: amount,
      amountBasis: 'MONTHLY',
      isEnabled: true,
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
      component: { type: 'EARNING' },
    });
    const { service } = build({
      components: [row('BASIC', 30000), row('HRA', 12000)],
    }); // 42,000 -> limit 12,600
    await expect(
      service.create(
        {
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 156000,
          interestRate: 0,
          tenureMonths: 12,
          ...thisMonth,
        } as never,
        admin,
        'org',
      ), // EMI 13,000
    ).rejects.toThrow(/above the 30% limit/);
    await expect(
      service.create(
        {
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 144000,
          interestRate: 0,
          tenureMonths: 12,
          ...thisMonth,
        } as never,
        admin,
        'org',
      ), // EMI 12,000
    ).resolves.toBeTruthy();
  });

  it('an employee with no salary on record cannot be given a loan', async () => {
    const { service } = build();
    await expect(
      service.create(
        {
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 1000,
          interestRate: 0,
          tenureMonths: 2,
          ...thisMonth,
        } as never,
        admin,
        'org',
      ),
    ).rejects.toThrow(/no salary on record/);
  });

  it('a loan for an HR or Admin employee has to be sanctioned by an Admin', async () => {
    const { service } = build({
      employee: EMP({ role: Role.HR }),
      runs: salary,
    });
    await expect(
      service.create(
        {
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 12000,
          interestRate: 0,
          tenureMonths: 12,
          ...thisMonth,
        } as never,
        hr,
        'org',
      ),
    ).rejects.toThrow(/has to be sanctioned by an Admin/);
  });

  it('the first EMI month must be sensible (not far in the past or the future)', async () => {
    const { service } = build({ runs: salary });
    await expect(
      service.create(
        {
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 12000,
          interestRate: 0,
          tenureMonths: 12,
          startMonth: 1,
          startYear: 2020,
        } as never,
        admin,
        'org',
      ),
    ).rejects.toThrow(/months in the past/);
    await expect(
      service.create(
        {
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 12000,
          interestRate: 0,
          tenureMonths: 12,
          startMonth: 1,
          startYear: now.getUTCFullYear() + 3,
        } as never,
        admin,
        'org',
      ),
    ).rejects.toThrow(/months from now/);
  });
});

describe('loans: employee requests', () => {
  it('a request waits as Pending with an indicative EMI', async () => {
    const { service } = build();
    const loan = await service.request(
      { loanType: LoanType.LOAN, principal: 60000, tenureMonths: 6 } as never,
      { id: 'e1', name: 'Asha', role: Role.EMPLOYEE } as never,
      'org',
    );
    expect(loan.status).toBe(LoanStatus.PENDING);
    expect(loan.emiAmount).toBe(10000);
  });

  it('only one request can wait at a time', async () => {
    const { service } = build({
      loans: [{ id: 'p', employeeId: 'e1', status: LoanStatus.PENDING }],
    });
    await expect(
      service.request(
        { loanType: LoanType.LOAN, principal: 1000, tenureMonths: 2 } as never,
        { id: 'e1', name: 'Asha', role: Role.EMPLOYEE } as never,
        'org',
      ),
    ).rejects.toThrow(/already have a loan\/advance request waiting/);
  });

  it('approving sets the real terms and makes it Active', async () => {
    const { service, loans } = build({
      runs: salary,
      loans: [
        {
          id: 'p',
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 60000,
          tenureMonths: 6,
          status: LoanStatus.PENDING,
        },
      ],
    });
    const out = await service.approve(
      'p',
      { interestRate: 0, tenureMonths: 12, ...thisMonth } as never,
      admin,
      'org',
    );
    expect(out.status).toBe(LoanStatus.ACTIVE);
    expect(loans[0]).toMatchObject({
      emiAmount: 5000,
      tenureMonths: 12,
      outstandingBalance: 60000,
      approvedById: 'admin',
    });
  });

  it('approving applies the same 30% cap', async () => {
    const { service, loans } = build({
      runs: salary,
      loans: [
        {
          id: 'p',
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 600000,
          tenureMonths: 6,
          status: LoanStatus.PENDING,
        },
      ],
    });
    await expect(
      service.approve(
        'p',
        { interestRate: 0, ...thisMonth } as never,
        admin,
        'org',
      ),
    ).rejects.toThrow(/above the 30% limit/);
    expect(loans[0].status).toBe(LoanStatus.PENDING);
  });

  it('only a pending request can be approved or rejected, and not twice', async () => {
    const { service } = build({
      loans: [{ id: 'a', employeeId: 'e1', status: LoanStatus.ACTIVE }],
    });
    await expect(
      service.approve('a', { ...thisMonth } as never, admin, 'org'),
    ).rejects.toThrow(/Only a pending request can be approved/);
    await expect(
      service.reject('a', {} as never, admin, 'org'),
    ).rejects.toThrow(/Only a pending request can be rejected/);
    await expect(
      service.approve('ghost', { ...thisMonth } as never, admin, 'org'),
    ).rejects.toThrow(/Loan not found/);
  });

  it('HR cannot approve or reject their own request, an Admin can', async () => {
    const mine = build({
      employee: EMP({ id: 'hr1', role: Role.HR }),
      runs: salary,
      loans: [
        {
          id: 'p',
          employeeId: 'hr1',
          loanType: LoanType.LOAN,
          principal: 12000,
          tenureMonths: 12,
          status: LoanStatus.PENDING,
        },
      ],
    });
    await expect(
      mine.service.approve(
        'p',
        { interestRate: 0, ...thisMonth } as never,
        hr,
        'org',
      ),
    ).rejects.toThrow(/own request/);
    await expect(
      mine.service.reject('p', {} as never, hr, 'org'),
    ).rejects.toThrow(/own request/);
  });

  it('a rejected request records who rejected it and tells the employee why', async () => {
    const { service, loans, notes } = build({
      loans: [
        {
          id: 'p',
          employeeId: 'e1',
          loanType: LoanType.LOAN,
          principal: 5000,
          status: LoanStatus.PENDING,
        },
      ],
    });
    await service.reject(
      'p',
      { reason: 'Not eligible yet' } as never,
      admin,
      'org',
    );
    expect(loans[0].status).toBe(LoanStatus.REJECTED);
    expect(notes.at(-1)?.message).toMatch(/rejected: Not eligible yet/);
  });
});

describe('loans: status changes', () => {
  const active = (over: Row = {}) => ({
    id: 'a',
    employeeId: 'e1',
    loanType: LoanType.LOAN,
    status: LoanStatus.ACTIVE,
    outstandingBalance: 5000,
    ...over,
  });

  it('a pending request must go through approve/reject, not a status flip', async () => {
    const { service } = build({
      loans: [active({ status: LoanStatus.PENDING })],
    });
    await expect(
      service.updateStatus(
        'a',
        { status: LoanStatus.ACTIVE } as never,
        'org',
        'admin',
      ),
    ).rejects.toThrow(/approve or reject/);
  });

  it('closing a loan that still has a balance needs a reason', async () => {
    const { service, loans } = build({ loans: [active()] });
    await expect(
      service.updateStatus(
        'a',
        { status: LoanStatus.CLOSED } as never,
        'org',
        'admin',
      ),
    ).rejects.toThrow(/reason is required to close/);
    await service.updateStatus(
      'a',
      { status: LoanStatus.CLOSED, reason: 'Waived by management' } as never,
      'org',
      'admin',
    );
    expect(loans[0]).toMatchObject({
      status: LoanStatus.CLOSED,
      closureReason: 'Waived by management',
      closedById: 'admin',
    });
  });

  it('cancelling needs a reason', async () => {
    const { service } = build({ loans: [active()] });
    await expect(
      service.updateStatus(
        'a',
        { status: LoanStatus.CANCELLED } as never,
        'org',
        'admin',
      ),
    ).rejects.toThrow(/reason is required to cancel/);
  });

  it('a closed or cancelled loan can never be reopened or swapped', async () => {
    const closed = build({ loans: [active({ status: LoanStatus.CLOSED })] });
    await expect(
      closed.service.updateStatus(
        'a',
        { status: LoanStatus.ACTIVE } as never,
        'org',
        'admin',
      ),
    ).rejects.toThrow(/can't be changed to active/);
    const cancelled = build({
      loans: [active({ status: LoanStatus.CANCELLED })],
    });
    await expect(
      cancelled.service.updateStatus(
        'a',
        { status: LoanStatus.CLOSED, reason: 'x' } as never,
        'org',
        'admin',
      ),
    ).rejects.toThrow(/can't be changed to closed/);
  });

  it('every status change is audited', async () => {
    const { service, audit } = build({ loans: [active()] });
    await service.updateStatus(
      'a',
      { status: LoanStatus.CANCELLED, reason: 'Left' } as never,
      'org',
      'admin',
    );
    expect(audit.at(-1)).toMatchObject({
      action: 'LOAN_STATUS_UPDATED',
      details: { fromStatus: 'ACTIVE', toStatus: 'CANCELLED' },
    });
  });
});

describe('loans: repayments', () => {
  const active = (over: Row = {}) => ({
    id: 'a',
    employeeId: 'e1',
    status: LoanStatus.ACTIVE,
    outstandingBalance: 10000,
    interestRate: 0,
    ...over,
  });

  it('a repayment reduces the balance and is recorded with the balance after it', async () => {
    const { service, loans, repayments } = build({ loans: [active()] });
    const r = await service.recordRepayment(
      'a',
      { amount: 4000, month: 10, year: 2026 } as never,
      'org',
      'admin',
    );
    expect(loans[0].outstandingBalance).toBe(6000);
    expect(repayments[0]).toMatchObject({
      amount: 4000,
      principalComponent: 4000,
      interestComponent: 0,
      balanceAfter: 6000,
    });
    expect(r.loan.outstandingBalance).toBe(6000);
  });

  it('paying it off closes the loan', async () => {
    const { service, loans } = build({
      loans: [active({ outstandingBalance: 3000 })],
    });
    await service.recordRepayment(
      'a',
      { amount: 3000, month: 10, year: 2026 } as never,
      'org',
      'admin',
    );
    expect(loans[0]).toMatchObject({
      outstandingBalance: 0,
      status: LoanStatus.CLOSED,
    });
  });

  it('with interest, the interest is taken first and only the rest reduces the balance', async () => {
    const { service, loans, repayments } = build({
      loans: [active({ outstandingBalance: 100000, interestRate: 12 })],
    });
    await service.recordRepayment(
      'a',
      { amount: 8885, month: 10, year: 2026 } as never,
      'org',
      'admin',
    );
    expect(repayments[0]).toMatchObject({
      interestComponent: 1000,
      principalComponent: 7885,
    });
    expect(loans[0].outstandingBalance).toBe(92115);
  });

  it('only an active loan can be repaid', async () => {
    for (const status of [
      LoanStatus.PENDING,
      LoanStatus.REJECTED,
      LoanStatus.CLOSED,
      LoanStatus.CANCELLED,
    ]) {
      const { service } = build({ loans: [active({ status })] });
      await expect(
        service.recordRepayment(
          'a',
          { amount: 10, month: 10, year: 2026 } as never,
          'org',
        ),
      ).rejects.toThrow(/Only an active loan/);
    }
  });

  it('a hand-entered repayment cannot be more than is still owed, nor a second one for the same month', async () => {
    const { service } = build({
      loans: [active()],
      repayments: [{ id: 'r0', loanId: 'a', month: 9, year: 2026 }],
    });
    await expect(
      service.recordRepayment(
        'a',
        { amount: 20000, month: 10, year: 2026 } as never,
        'org',
      ),
    ).rejects.toThrow(/more than is still owed on the loan \(10000\)/);
    await expect(
      service.recordRepayment(
        'a',
        { amount: 1000, month: 9, year: 2026 } as never,
        'org',
      ),
    ).rejects.toThrow(/already recorded/);
  });

  it('a repayment from the payroll lock skips the hand-entry checks', async () => {
    const { service, repayments } = build({
      loans: [active()],
      repayments: [{ id: 'r0', loanId: 'a', month: 10, year: 2026 }],
    });
    await service.recordRepayment(
      'a',
      { amount: 1000, month: 10, year: 2026, payrollRun: 'run1' } as never,
      'org',
    );
    expect(repayments.at(-1)).toMatchObject({ payrollRunId: 'run1' });
  });

  it('an unknown loan is not found', async () => {
    const { service } = build();
    await expect(
      service.recordRepayment(
        'ghost',
        { amount: 1, month: 1, year: 2026 } as never,
        'org',
      ),
    ).rejects.toThrow(/Loan not found/);
  });
});
