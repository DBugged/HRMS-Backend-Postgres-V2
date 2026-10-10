import { Role } from '@prisma/client';
import { LeaveEncashmentsService } from './leave-encashments.service';

type Row = Record<string, any>;

function build(
  opts: {
    leaveType?: Row | null;
    balance?: Partial<Row>;
    basicMonthly?: number;
    policies?: Row;
    requestedDays?: number;
    rows?: Row[];
  } = {},
) {
  const balance: Row = {
    id: 'b1',
    opening: 0,
    credited: 12,
    availed: 0,
    pending: 0,
    encashed: 0,
    adjusted: 0,
    closing: 12,
    ...opts.balance,
  };
  const rows: Row[] = (opts.rows ?? []).map((r) => ({
    organizationId: 'org',
    ...r,
  }));
  const audit: Row[] = [];
  const notes: Row[] = [];
  const leaveType =
    opts.leaveType === undefined
      ? {
          id: 'lt1',
          name: 'Earned Leave',
          encashment: {
            allowed: true,
            maxDaysPerYear: 10,
            minBalanceToRetain: 2,
          },
        }
      : opts.leaveType;
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(
      ([k, v]) => k === 'organizationId' || v === undefined || r[k] === v,
    );
  const tx: Row = {
    $queryRaw: async () => [],
    organization: {
      findFirst: async () => ({
        timezone: 'Asia/Kolkata',
        policies: opts.policies ?? {},
      }),
    },
    leaveBalance: {
      updateMany: async (a: Row) => {
        for (const [k, v] of Object.entries(a.data as Row)) {
          if (v && typeof v === 'object' && 'increment' in v)
            balance[k] += v.increment;
          else if (v && typeof v === 'object' && 'decrement' in v)
            balance[k] -= v.decrement;
        }
        balance.closing =
          balance.opening +
          balance.credited -
          balance.availed -
          balance.encashed +
          balance.adjusted;
        return { count: 1 };
      },
    },
    leaveEncashment: {
      aggregate: async () => ({ _sum: { days: opts.requestedDays ?? 0 } }),
      create: async (a: Row) => {
        const row = {
          id: `en${rows.length + 1}`,
          status: 'PENDING',
          organizationId: 'org',
          ...a.data,
        };
        rows.push(row);
        return { ...row };
      },
      updateMany: async (a: Row) => {
        const hits = rows.filter((r) => match(r, a.where));
        hits.forEach((r) => Object.assign(r, a.data));
        return { count: hits.length };
      },
      findFirstOrThrow: async (a: Row) => ({
        ...rows.find((r) => match(r, a.where))!,
      }),
    },
  };
  const prisma: Row = {
    ...tx,
    leaveType: { findFirst: async () => leaveType },
    leaveEncashment: {
      ...tx.leaveEncashment,
      findFirst: async (a: Row) => {
        const r = rows.find((x) => match(x, a?.where));
        return r ? { ...r } : null;
      },
    },
    user: {
      findFirst: async (a: Row) => ({
        id: a?.where?.id ?? 'e1',
        name: 'Asha',
        email: 'a@x.com',
        departmentId: 'd1',
      }),
    },
    $transaction: async (cb: (t: Row) => unknown) => cb(tx),
  };
  const stub = <T>(x: T) => x as never;
  const service = new LeaveEncashmentsService(
    stub(prisma),
    stub({
      ensureBalanceRow: async () => balance,
      forfeitedCarryIn: async () => new Map(),
      recalculate: async () => balance,
    }),
    stub({ getOrCreate: async () => ({ financialYearStartMonth: 4 }) }),
    stub({ getCurrentMonthlyValue: async () => opts.basicMonthly ?? 30000 }),
    stub({
      create: async (n: Row) => notes.push(n),
      notifyReviewers: async () => undefined,
    }),
    stub({ send: async () => undefined }),
    stub({
      log: async (e: Row) => audit.push(e),
      logSelfApproval: async () => undefined,
    }),
    stub({ logEvent: async () => undefined }),
    stub({ renderOccasion: async () => ({ subject: 's', html: 'h' }) }),
  );
  return { service, balance, rows, audit, notes };
}

const emp = {
  id: 'e1',
  role: Role.EMPLOYEE,
  name: 'Asha',
  departmentId: 'd1',
} as never;
const hr = {
  id: 'hr1',
  role: Role.HR,
  name: 'HR',
  departmentId: null,
} as never;
const admin = { id: 'ad', role: Role.ADMIN, name: 'Admin' } as never;

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('leave encashment: requesting', () => {
  it('pays Basic ÷ 30 per day: 4 days on a 30,000 Basic is 4,000, held against the balance', async () => {
    const { service, balance, rows } = build();
    const r = await service.request(
      { leaveType: 'lt1', days: 4 } as never,
      emp,
      'org',
    );
    expect(r).toMatchObject({
      days: 4,
      ratePerDay: 1000,
      amount: 4000,
      financialYear: '2026-27',
    });
    expect(rows).toHaveLength(1);
    expect(balance.pending).toBe(4);
    expect(balance.closing).toBe(12); // pending is a hold, not yet a deduction
  });

  it('keeps the minimum balance the leave type says must be retained', async () => {
    const { service } = build({
      leaveType: {
        id: 'lt1',
        name: 'Earned Leave',
        encashment: {
          allowed: true,
          maxDaysPerYear: 30,
          minBalanceToRetain: 2,
        },
      },
    }); // 12 available, retain 2 -> at most 10
    await expect(
      service.request({ leaveType: 'lt1', days: 11 } as never, emp, 'org'),
    ).rejects.toThrow(/Cannot encash more than 10 day\(s\) \(must retain 2\)/);
    await expect(
      service.request({ leaveType: 'lt1', days: 10 } as never, emp, 'org'),
    ).resolves.toBeTruthy();
  });

  it('days already on hold are not available again', async () => {
    const { service } = build({ balance: { pending: 6 } }); // 12 - 6 = 6 available, retain 2 -> 4
    await expect(
      service.request({ leaveType: 'lt1', days: 5 } as never, emp, 'org'),
    ).rejects.toThrow(/Cannot encash more than 4 day\(s\)/);
    await expect(
      service.request({ leaveType: 'lt1', days: 4 } as never, emp, 'org'),
    ).resolves.toBeTruthy();
  });

  it('the yearly cap counts what was already requested this year', async () => {
    const { service } = build({ requestedDays: 8 }); // cap 10
    await expect(
      service.request({ leaveType: 'lt1', days: 3 } as never, emp, 'org'),
    ).rejects.toThrow(/8 day\(s\) already requested this year/);
    await expect(
      service.request({ leaveType: 'lt1', days: 2 } as never, emp, 'org'),
    ).resolves.toBeTruthy();
  });

  it('a single request above the yearly cap is refused straight away', async () => {
    const { service } = build();
    await expect(
      service.request({ leaveType: 'lt1', days: 11 } as never, emp, 'org'),
    ).rejects.toThrow(/Cannot encash more than 10 day\(s\)|must retain/);
  });

  it('a leave type that does not allow encashment, an unknown type, and a switched-off organisation are all refused', async () => {
    const no = build({
      leaveType: {
        id: 'lt1',
        name: 'Sick Leave',
        encashment: { allowed: false },
      },
    });
    await expect(
      no.service.request({ leaveType: 'lt1', days: 1 } as never, emp, 'org'),
    ).rejects.toThrow(/Sick Leave does not allow encashment/);
    const none = build({ leaveType: null });
    await expect(
      none.service.request({ leaveType: 'x', days: 1 } as never, emp, 'org'),
    ).rejects.toThrow(/Leave type not found/);
    const off = build({ policies: { allowLeaveEncashment: false } });
    await expect(
      off.service.request({ leaveType: 'lt1', days: 1 } as never, emp, 'org'),
    ).rejects.toThrow(/turned off for the whole organization/);
  });

  it('zero days cannot be requested', async () => {
    const { service } = build();
    await expect(
      service.request({ leaveType: 'lt1', days: 0 } as never, emp, 'org'),
    ).rejects.toThrow(/Cannot encash/);
  });

  it('the request is audited', async () => {
    const { service, audit } = build();
    await service.request({ leaveType: 'lt1', days: 2 } as never, emp, 'org');
    expect(audit.at(-1)).toMatchObject({
      action: 'LEAVE_ENCASHMENT_REQUESTED',
      details: { days: 2, amount: 2000 },
    });
  });
});

describe('leave encashment: review', () => {
  const pending = (over: Row = {}) => ({
    id: 'en1',
    employeeId: 'e1',
    leaveTypeId: 'lt1',
    days: 4,
    amount: 4000,
    status: 'PENDING',
    ...over,
  });

  it('approving turns the hold into a real deduction from the balance', async () => {
    const { service, balance, rows } = build({
      rows: [pending()],
      balance: { pending: 4 },
    });
    await service.review('en1', { status: 'APPROVED' } as never, hr, 'org');
    expect(rows[0]).toMatchObject({ status: 'APPROVED', approvedById: 'hr1' });
    expect(balance).toMatchObject({ pending: 0, encashed: 4, closing: 8 });
  });

  it('marking it processed does not touch the balance again', async () => {
    const { service, balance } = build({
      rows: [pending({ status: 'APPROVED' })],
      balance: { pending: 0, encashed: 4, closing: 8 },
    });
    await service.review('en1', { status: 'PROCESSED' } as never, hr, 'org');
    expect(balance.encashed).toBe(4);
    expect(balance.closing).toBe(8);
  });

  it('only Pending can be approved and only Approved can be processed, and never twice', async () => {
    const approved = build({ rows: [pending({ status: 'APPROVED' })] });
    await expect(
      approved.service.review(
        'en1',
        { status: 'APPROVED' } as never,
        hr,
        'org',
      ),
    ).rejects.toThrow(/already reviewed/);
    const fresh = build({ rows: [pending()] });
    await expect(
      fresh.service.review('en1', { status: 'PROCESSED' } as never, hr, 'org'),
    ).rejects.toThrow(/already reviewed/);
  });

  it('nobody, an Admin included, can review their own request', async () => {
    const { service } = build({ rows: [pending({ employeeId: 'ad' })] });
    await expect(
      service.review('en1', { status: 'APPROVED' } as never, admin, 'org'),
    ).rejects.toThrow(/cannot approve or review your own request/);
  });

  it('approval is refused while the organisation has encashment switched off', async () => {
    const { service } = build({
      rows: [pending()],
      policies: { allowLeaveEncashment: false },
    });
    await expect(
      service.review('en1', { status: 'APPROVED' } as never, hr, 'org'),
    ).rejects.toThrow(/turned off for the whole organization/);
  });

  it('an unknown request is not found, and the employee is told the outcome', async () => {
    const none = build();
    await expect(
      none.service.review('ghost', { status: 'APPROVED' } as never, hr, 'org'),
    ).rejects.toThrow(/not found/);
    const { service, notes } = build({
      rows: [pending()],
      balance: { pending: 4 },
    });
    await service.review('en1', { status: 'APPROVED' } as never, hr, 'org');
    expect(notes.at(-1)?.message).toMatch(
      /4 day\(s\) \(4000\) has been approved/,
    );
  });
});
