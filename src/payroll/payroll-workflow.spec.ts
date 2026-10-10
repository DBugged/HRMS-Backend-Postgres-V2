import { Role } from '@prisma/client';
import { PayrollService } from './payroll.service';

type Row = Record<string, any>;

// An in-memory payroll_runs table plus "everything else is empty", enough to drive the sign-off workflow.
function build(runs: Row[], extra: Record<string, Row> = {}) {
  const audit: Row[] = [];
  const store = runs.map((r) => ({ ...r }));
  const match = (r: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'organizationId') return true;
      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k]);
      return v === undefined || r[k] === v;
    });
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    updateMany: async () => ({ count: 1 }),
    count: async () => 0,
    create: async (a: Row) => a.data,
  };
  const prisma: Row = new Proxy(
    {
      payrollRun: {
        findMany: async (a: Row) => store.filter((r) => match(r, a?.where)),
        findFirst: async (a: Row) =>
          store.find((r) => match(r, a?.where)) ?? null,
        findFirstOrThrow: async (a: Row) => {
          const r = store.find((x) => match(x, a?.where));
          if (!r) throw new Error('not found');
          return r;
        },
        updateMany: async (a: Row) => {
          const hits = store.filter((r) => match(r, a.where));
          hits.forEach((r) => Object.assign(r, a.data));
          return { count: hits.length };
        },
      },
      organization: {
        findFirst: async () => ({ timezone: 'Asia/Kolkata' }),
        findUnique: async () => ({ timezone: 'Asia/Kolkata' }),
      },
      user: { findFirst: async () => null },
      ...extra,
    } as Row,
    { get: (t, p: string) => t[p] ?? empty },
  );
  const stub = <T>(x: T) => x as never;
  const service = new PayrollService(
    stub(prisma),
    stub({}),
    stub({}),
    stub({ log: async (e: Row) => audit.push(e) }),
    stub({ logEvent: async () => undefined }),
    stub({ generatePayslipPdf: async () => Buffer.from('x') }),
    stub({ create: async () => undefined }),
    stub({ send: async () => undefined }),
    stub({ enqueue: async () => undefined }),
    stub({ renderOccasion: async () => ({ subject: 's', html: 'h' }) }),
    stub({}),
  );
  return { service, store, audit };
}

const run = (over: Row = {}): Row => ({
  id: 'r1',
  organizationId: 'org',
  employeeId: 'emp',
  month: 9,
  year: 2026,
  status: 'CALCULATED',
  isFinalSettlement: false,
  grossSalary: 42000,
  netPay: 42000,
  totalDeductions: 0,
  totalEmployerContributions: 0,
  ctcMonthly: 42000,
  taxableGross: 42000,
  earnings: [{ code: 'BASIC', name: 'Basic', amount: 42000 }],
  deductions: [],
  employerContributions: [],
  calculatedById: 'calc',
  verifiedById: null,
  approvedById: null,
  ...over,
});

const hr = (id: string, role: Role = Role.HR) => ({ id, role }) as never;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z'));
});
afterEach(() => jest.useRealTimers());

describe('payroll workflow: the sign-off chain', () => {
  it('Calculated -> Verified -> Approved -> Locked -> Paid, one step at a time', async () => {
    const { service, store } = build([run()]);
    expect((await service.verify('r1', hr('v1'), 'org')).status).toBe(
      'VERIFIED',
    );
    expect((await service.approve('r1', hr('a1'), 'org')).status).toBe(
      'APPROVED',
    );
    expect((await service.lock('r1', hr('l1'), 'org')).status).toBe('LOCKED');
    expect((await service.pay('r1', hr('p1'), 'org')).status).toBe('PAID');
    expect(store[0]).toMatchObject({
      verifiedById: 'v1',
      approvedById: 'a1',
      lockedById: 'l1',
      paidById: 'p1',
    });
  });

  it('a step cannot be skipped: Calculated cannot be approved, locked or paid', async () => {
    const { service } = build([run()]);
    await expect(service.approve('r1', hr('a1'), 'org')).rejects.toThrow(
      /Cannot move payroll from "CALCULATED" to "APPROVED"/,
    );
    await expect(service.lock('r1', hr('a1'), 'org')).rejects.toThrow(
      /Cannot move/,
    );
    await expect(service.pay('r1', hr('a1'), 'org')).rejects.toThrow(
      /Cannot move/,
    );
  });

  it('a step cannot be repeated', async () => {
    const { service } = build([run({ status: 'VERIFIED' })]);
    await expect(service.verify('r1', hr('v1'), 'org')).rejects.toThrow(
      /Cannot move/,
    );
  });

  it('an unknown run is "not found"', async () => {
    const { service } = build([]);
    await expect(service.verify('nope', hr('v1'), 'org')).rejects.toThrow(
      /Payroll run not found/,
    );
  });

  it('every step is written to the audit log', async () => {
    const { service, audit } = build([run()]);
    await service.verify('r1', hr('v1'), 'org');
    await service.approve('r1', hr('a1'), 'org');
    expect(audit.map((a) => a.action)).toEqual([
      'PAYROLL_VERIFIED',
      'PAYROLL_APPROVED',
    ]);
  });

  it('a run with nothing to pay (gross 0) cannot be verified', async () => {
    const { service } = build([run({ grossSalary: 0, netPay: 0 })]);
    await expect(service.verify('r1', hr('v1'), 'org')).rejects.toThrow(
      /gross is 0/,
    );
  });

  it('a negative net pay can never move forward', async () => {
    const { service } = build([run({ netPay: -500 })]);
    await expect(service.verify('r1', hr('v1'), 'org')).rejects.toThrow(
      /negative net pay/,
    );
  });

  it('a non-numeric amount can never move forward', async () => {
    const { service } = build([run({ netPay: Number.NaN })]);
    await expect(service.verify('r1', hr('v1'), 'org')).rejects.toThrow(
      /non-numeric/,
    );
  });

  it('a month that has not started cannot be signed off', async () => {
    const { service } = build([run({ month: 12, year: 2026 })]);
    await expect(service.verify('r1', hr('v1'), 'org')).rejects.toThrow(
      /that month has not started/,
    );
  });

  it('a final-settlement payslip is managed from Settlements, not here', async () => {
    const { service } = build([run({ isFinalSettlement: true })]);
    await expect(service.verify('r1', hr('v1'), 'org')).rejects.toThrow(
      /Settlements/,
    );
  });
});

describe('payroll workflow: separation of duties', () => {
  it('HR cannot verify, approve, lock or pay their own payslip', async () => {
    for (const [status, action] of [
      ['CALCULATED', 'verify'],
      ['VERIFIED', 'approve'],
      ['APPROVED', 'lock'],
      ['LOCKED', 'pay'],
    ] as const) {
      const { service } = build([run({ status, employeeId: 'me' })]);
      await expect(
        (
          service as never as Record<
            string,
            (...a: unknown[]) => Promise<unknown>
          >
        )[action]('r1', hr('me'), 'org'),
      ).rejects.toThrow(/your own payslip/);
    }
  });

  it('an Admin may sign off their own payslip', async () => {
    const { service } = build([run({ employeeId: 'boss' })]);
    expect(
      (await service.verify('r1', hr('boss', Role.ADMIN), 'org')).status,
    ).toBe('VERIFIED');
  });

  it('whoever calculated or verified a run cannot approve it', async () => {
    const a = build([run({ status: 'VERIFIED', calculatedById: 'x' })]);
    await expect(a.service.approve('r1', hr('x'), 'org')).rejects.toThrow(
      /someone other than the person who calculated or verified/,
    );
    const b = build([run({ status: 'VERIFIED', verifiedById: 'y' })]);
    await expect(b.service.approve('r1', hr('y'), 'org')).rejects.toThrow(
      /someone other than the person who calculated or verified/,
    );
  });

  it('whoever approved a run cannot be the one to mark it paid', async () => {
    const { service } = build([run({ status: 'LOCKED', approvedById: 'z' })]);
    await expect(service.pay('r1', hr('z'), 'org')).rejects.toThrow(
      /someone other than the person who approved/,
    );
  });

  it('an Admin is exempt from the approver rule', async () => {
    const { service } = build([
      run({ status: 'VERIFIED', calculatedById: 'ad', verifiedById: 'ad' }),
    ]);
    expect(
      (await service.approve('r1', hr('ad', Role.ADMIN), 'org')).status,
    ).toBe('APPROVED');
  });
});

describe('payroll workflow: bulk sign-off', () => {
  it('moves the eligible runs and reports the rest as skipped, in one call', async () => {
    const { service } = build([
      run({ id: 'a', status: 'CALCULATED' }),
      run({ id: 'b', status: 'CALCULATED', employeeId: 'emp2' }),
      run({ id: 'c', status: 'APPROVED', employeeId: 'emp3' }),
    ]);
    const res = await service.bulkTransition(
      { ids: ['a', 'b', 'c', 'ghost'], action: 'verify' } as never,
      hr('v1'),
      'org',
    );
    expect(res.updatedCount).toBe(2);
    expect(res.skipped.map((s: Row) => `${s.id}:${s.status}`).sort()).toEqual([
      'c:APPROVED',
      'ghost:not_found',
    ]);
  });
});

describe('payroll workflow: unlock', () => {
  it('only a Locked or Paid run can be unlocked', async () => {
    const { service } = build([run({ status: 'APPROVED' })]);
    await expect(
      service.unlock(
        'r1',
        { reason: 'fix' } as never,
        hr('a', Role.ADMIN),
        'org',
      ),
    ).rejects.toThrow(/Only locked or paid payroll can be unlocked/);
  });

  it('a Locked run goes back to Calculated with its sign-off marks cleared and the reason kept', async () => {
    const { service, store, audit } = build([
      run({
        status: 'LOCKED',
        verifiedById: 'v',
        approvedById: 'a',
        lockedById: 'l',
        paidAt: null,
      }),
    ]);
    const r = await service.unlock(
      'r1',
      { reason: '  wrong attendance  ' } as never,
      hr('h2'),
      'org',
    );
    expect(r.status).toBe('CALCULATED');
    expect(store[0]).toMatchObject({
      unlockReason: 'wrong attendance',
      unlockedById: 'h2',
      verifiedById: null,
      approvedById: null,
      lockedById: null,
      paidById: null,
      payslipEmailSentAt: null,
    });
    expect(audit.at(-1)?.action).toBe('PAYROLL_UNLOCKED');
  });

  it('a Paid run can be reopened only by an Admin', async () => {
    const hrTry = build([run({ status: 'PAID' })]);
    await expect(
      hrTry.service.unlock('r1', { reason: 'x' } as never, hr('h2'), 'org'),
    ).rejects.toThrow(
      /Only an Admin can unlock payroll that is already marked as paid/,
    );
    const adminTry = build([run({ status: 'PAID' })]);
    expect(
      (
        await adminTry.service.unlock(
          'r1',
          { reason: 'x' } as never,
          hr('ad', Role.ADMIN),
          'org',
        )
      ).status,
    ).toBe('CALCULATED');
  });

  it('HR cannot unlock their own payslip', async () => {
    const { service } = build([run({ status: 'LOCKED', employeeId: 'me' })]);
    await expect(
      service.unlock('r1', { reason: 'x' } as never, hr('me'), 'org'),
    ).rejects.toThrow(/your own payslip/);
  });

  it('a final-settlement payslip cannot be unlocked here', async () => {
    const { service } = build([
      run({ status: 'LOCKED', isFinalSettlement: true }),
    ]);
    await expect(
      service.unlock('r1', { reason: 'x' } as never, hr('h2'), 'org'),
    ).rejects.toThrow(/Settlements/);
  });
});

describe('payroll workflow: locking guards against a stale payslip', () => {
  it('a payslip whose loan EMI is for a loan that is no longer active is sent back to Calculated', async () => {
    const stale = run({
      status: 'APPROVED',
      deductions: [
        {
          code: 'LOAN_EMI',
          name: 'Loan EMI',
          amount: 5000,
          sourceIds: ['loan1'],
        },
      ],
    });
    const { service, store } = build([stale], {
      loan: {
        findFirst: async () => ({
          id: 'loan1',
          status: 'CLOSED',
          outstandingBalance: 0,
          interestRate: 0,
        }),
      },
    });
    await expect(service.lock('r1', hr('l1'), 'org')).rejects.toThrow(
      /no longer active.*recalculate this payroll run before locking it/s,
    );
    expect(store[0].status).toBe('CALCULATED');
  });

  it('a payslip that pays a leave encashment already paid elsewhere cannot be locked', async () => {
    const stale = run({
      status: 'APPROVED',
      earnings: [
        {
          code: 'LEAVE_ENCASHMENT',
          name: 'Encashment',
          amount: 3000,
          sourceIds: ['enc1'],
        },
      ],
    });
    const { service, store } = build([stale], {
      leaveEncashment: {
        findMany: async () => [
          { id: 'enc1', status: 'PROCESSED', payrollRunId: 'other-run' },
        ],
        updateMany: async () => ({ count: 1 }),
      },
    });
    await expect(service.lock('r1', hr('l1'), 'org')).rejects.toThrow(
      /already been paid in another payroll run/,
    );
    expect(store[0].status).toBe('CALCULATED');
  });
});

describe('payroll workflow: paying', () => {
  it('a failure while sending the payslip never fails the payment itself', async () => {
    const { service, store } = build([run({ status: 'LOCKED' })], {
      user: {
        findFirst: async () => {
          throw new Error('mail server down');
        },
      },
    });
    const r = await service.pay('r1', hr('p1'), 'org');
    expect(r.status).toBe('PAID');
    expect(store[0].status).toBe('PAID');
  });
});

import { nonFiniteMoneyField } from './payroll.service';

describe('nonFiniteMoneyField', () => {
  const ok = {
    grossSalary: 1,
    totalDeductions: 0,
    totalEmployerContributions: 0,
    netPay: 1,
    ctcMonthly: 1,
    earnings: [{ code: 'BASIC', amount: 1 }],
    deductions: [],
    employerContributions: [],
  };
  it('is null when every figure is a finite number', () => {
    expect(nonFiniteMoneyField(ok)).toBeNull();
  });
  it('names a NaN or Infinity total', () => {
    expect(nonFiniteMoneyField({ ...ok, netPay: Number.NaN })).toBe('netPay');
    expect(nonFiniteMoneyField({ ...ok, grossSalary: Infinity })).toBe(
      'grossSalary',
    );
  });
  it('names a bad line, including a null amount that Postgres hands back for NaN', () => {
    expect(
      nonFiniteMoneyField({
        ...ok,
        deductions: [{ code: 'PF', amount: null }],
      }),
    ).toBe('deductions line PF');
  });
});
