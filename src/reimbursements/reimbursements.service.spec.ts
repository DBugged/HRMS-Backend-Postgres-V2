import { ReimbursementStatus, Role } from '@prisma/client';
import { ReimbursementsService } from './reimbursements.service';

type Row = Record<string, any>;

function build(
  claims: Row[] = [],
  employees: Row[] = [
    { id: 'e1', name: 'Asha', email: 'a@x.com', departmentId: 'd1' },
  ],
) {
  const store: Row[] = claims.map((c) => ({
    organizationId: 'org',
    category: 'TRAVEL',
    reviewComments: '',
    ...c,
  }));
  const audit: Row[] = [];
  const notes: Row[] = [];
  let seq = 0;
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'organizationId') return true;
      if (v && typeof v === 'object' && 'not' in v) return r[k] !== v.not;
      return v === undefined || r[k] === v;
    });
  const prisma: Row = {
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    user: {
      findFirst: async (a: Row) =>
        employees.find((e) => e.id === a?.where?.id) ?? null,
    },
    reimbursement: {
      findFirst: async (a: Row) => {
        const c = store.find((x) => match(x, a?.where));
        return c ? { ...c } : null;
      },
      findFirstOrThrow: async (a: Row) => ({
        ...store.find((x) => match(x, a?.where))!,
      }),
      create: async (a: Row) => {
        const row = {
          id: `c${++seq}`,
          organizationId: 'org',
          status: 'PENDING',
          reviewComments: '',
          ...a.data,
        };
        store.push(row);
        return { ...row };
      },
      updateMany: async (a: Row) => {
        const hits = store.filter((x) => match(x, a.where));
        hits.forEach((x) => Object.assign(x, a.data));
        return { count: hits.length };
      },
    },
  };
  const stub = <T>(x: T) => x as never;
  const service = new ReimbursementsService(
    stub(prisma),
    stub({
      create: async (n: Row) => notes.push(n),
      notifyReviewers: async (n: Row) => notes.push(n),
    }),
    stub({ send: async () => undefined }),
    stub({
      log: async (e: Row) => audit.push(e),
      logSelfApproval: async () => undefined,
    }),
    stub({ logEvent: async () => undefined }),
    stub({ renderOccasion: async () => ({ subject: 's', html: 'h' }) }),
  );
  return { service, store, audit, notes };
}

const emp = { id: 'e1', role: Role.EMPLOYEE, name: 'Asha' } as never;
const hr = {
  id: 'hr1',
  role: Role.HR,
  name: 'HR',
  departmentId: null,
} as never;
const admin = { id: 'ad', role: Role.ADMIN, name: 'Admin' } as never;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('reimbursement claims: submitting', () => {
  it('saves a claim as Pending and tells the reviewers', async () => {
    const { service, store, notes } = build();
    const c = await service.create(
      {
        category: 'TRAVEL',
        amount: 1500,
        claimDate: day(-2),
        description: 'Cab',
      } as never,
      emp,
      'org',
    );
    expect(c).toMatchObject({
      status: 'PENDING',
      amount: 1500,
      employeeId: 'e1',
    });
    expect(store).toHaveLength(1);
    expect(notes[0].title).toBe('Reimbursement Claim Submitted');
  });

  it('a missing category is "Other", not an error', async () => {
    const { service } = build();
    const c = await service.create(
      { amount: 100, claimDate: day(-1) } as never,
      emp,
      'org',
    );
    expect(c.category).toBe('OTHER');
  });

  it('a claim for a future date is refused', async () => {
    const { service } = build();
    await expect(
      service.create({ amount: 100, claimDate: day(5) } as never, emp, 'org'),
    ).rejects.toThrow(/cannot be in the future/);
  });

  it('a claim older than a year is refused', async () => {
    const { service } = build();
    await expect(
      service.create(
        { amount: 100, claimDate: day(-400) } as never,
        emp,
        'org',
      ),
    ).rejects.toThrow(/older than 365 days/);
  });

  it('the same claim twice is refused, but a rejected one can be sent again', async () => {
    const claim = { category: 'TRAVEL', amount: 500, claimDate: day(-3) };
    const dup = build([
      { id: 'c0', employeeId: 'e1', status: 'PENDING', ...claim },
    ]);
    await expect(
      dup.service.create(claim as never, emp, 'org'),
    ).rejects.toThrow(/already exists/);
    const resend = build([
      { id: 'c0', employeeId: 'e1', status: 'REJECTED', ...claim },
    ]);
    await expect(
      resend.service.create(claim as never, emp, 'org'),
    ).resolves.toBeTruthy();
  });

  it('a receipt is signed on the way out and an external link is passed through', async () => {
    process.env.FILE_TOKEN_SECRET = 'test-secret';
    const { service } = build();
    const c = await service.create(
      {
        amount: 100,
        claimDate: day(-1),
        receiptUrl: 'org/documents/r.pdf',
      } as never,
      emp,
      'org',
    );
    expect(c.receiptUrl).toMatch(/^\/files\//);
    expect(c.receiptFileName).toBe('r.pdf');
  });
});

describe('reimbursement claims: review', () => {
  const claim = (over: Row = {}) => ({
    id: 'c1',
    employeeId: 'e1',
    amount: 800,
    claimDate: day(-5),
    status: 'PENDING',
    ...over,
  });

  it('Pending -> Approved records who and when; Approved -> Paid records the mode and date', async () => {
    const { service, store } = build([claim()]);
    await service.review('c1', { status: 'APPROVED' } as never, hr, 'org');
    expect(store[0]).toMatchObject({
      status: 'APPROVED',
      approvedById: 'hr1',
      approvedDate: '2026-10-10',
    });
    await service.review(
      'c1',
      { status: 'PAID', paymentMode: 'TRANSFER' } as never,
      hr,
      'org',
    );
    expect(store[0]).toMatchObject({
      status: 'PAID',
      paidById: 'hr1',
      paymentMode: 'TRANSFER',
      paidDate: '2026-10-10',
    });
  });

  it('a claim cannot be paid before it is approved, and paying needs a payment mode', async () => {
    const { service } = build([claim()]);
    await expect(
      service.review(
        'c1',
        { status: 'PAID', paymentMode: 'CASH' } as never,
        hr,
        'org',
      ),
    ).rejects.toThrow(/Only an approved claim can be marked as paid/);
    const approved = build([claim({ status: 'APPROVED' })]);
    await expect(
      approved.service.review('c1', { status: 'PAID' } as never, hr, 'org'),
    ).rejects.toThrow(/Payment mode .* is required/);
  });

  it('Paid and Rejected are final', async () => {
    for (const status of ['PAID', 'REJECTED']) {
      const { service } = build([claim({ status })]);
      await expect(
        service.review('c1', { status: 'APPROVED' } as never, hr, 'org'),
      ).rejects.toThrow(/already .* and cannot be changed further/);
    }
  });

  it('an approved claim cannot be rejected afterwards', async () => {
    const { service } = build([claim({ status: 'APPROVED' })]);
    await expect(
      service.review('c1', { status: 'REJECTED' } as never, hr, 'org'),
    ).rejects.toThrow(/approved reimbursement cannot be rejected/);
  });

  it('the paid date cannot be in the future or before the claim date', async () => {
    const { service } = build([claim({ status: 'APPROVED' })]);
    await expect(
      service.review(
        'c1',
        { status: 'PAID', paymentMode: 'CASH', paidDate: day(3) } as never,
        hr,
        'org',
      ),
    ).rejects.toThrow(/cannot be in the future/);
    await expect(
      service.review(
        'c1',
        { status: 'PAID', paymentMode: 'CASH', paidDate: day(-20) } as never,
        hr,
        'org',
      ),
    ).rejects.toThrow(/before the claim date/);
    await expect(
      service.review(
        'c1',
        { status: 'PAID', paymentMode: 'CASH', paidDate: day(-1) } as never,
        hr,
        'org',
      ),
    ).resolves.toBeTruthy();
  });

  it('a rejection keeps the reviewer comments and tells the employee', async () => {
    const { service, store, notes } = build([claim()]);
    await service.review(
      'c1',
      { status: 'REJECTED', reviewComments: 'No receipt' } as never,
      hr,
      'org',
    );
    expect(store[0]).toMatchObject({
      status: 'REJECTED',
      reviewComments: 'No receipt',
    });
    expect(notes.at(-1)?.message).toMatch(/rejected.*Comments: No receipt/s);
  });

  it('HR cannot review their own claim, an Admin can', async () => {
    const mine = build(
      [claim({ employeeId: 'hr1' })],
      [{ id: 'hr1', name: 'HR', email: 'h@x.com' }],
    );
    await expect(
      mine.service.review('c1', { status: 'APPROVED' } as never, hr, 'org'),
    ).rejects.toThrow(/own request/);
    const boss = build(
      [claim({ employeeId: 'ad' })],
      [{ id: 'ad', name: 'Admin', email: 'a@x.com' }],
    );
    await expect(
      boss.service.review('c1', { status: 'APPROVED' } as never, admin, 'org'),
    ).resolves.toBeTruthy();
  });

  it('an unknown claim is not found', async () => {
    const { service } = build();
    await expect(
      service.review('ghost', { status: 'APPROVED' } as never, hr, 'org'),
    ).rejects.toThrow(/not found/);
  });

  it('bulk review moves what it can and says why for the rest', async () => {
    const { service, store } = build([
      claim({ id: 'a' }),
      claim({ id: 'b', status: 'PAID' }),
      claim({ id: 'c' }),
    ]);
    const r = await service.bulkReview(
      ['a', 'b', 'c', 'ghost'],
      { status: 'APPROVED' } as never,
      hr,
      'org',
    );
    expect(r.succeeded).toEqual(['a', 'c']);
    expect(r.failed.map((f) => f.id)).toEqual(['b', 'ghost']);
    expect(r.failed[0].message).toMatch(/already paid/);
    expect(
      store.filter((s) => s.status === ReimbursementStatus.APPROVED),
    ).toHaveLength(2);
  });
});
