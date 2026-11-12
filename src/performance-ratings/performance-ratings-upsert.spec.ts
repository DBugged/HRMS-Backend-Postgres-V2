// Purpose: who may rate an employee, and what a rating's status becomes.
// Covers: a MANAGER submits a rating for someone who reports to them (stays SUBMITTED, unpublished); a MANAGER cannot rate someone outside their line
//   or themselves; ADMIN / HR can rate and can CHANGE a rating, including one a manager submitted, which is then published with the reviewer recorded.
import { ForbiddenException } from '@nestjs/common';
import { PerformanceRatingStatus, Role } from '@prisma/client';
import { PerformanceRatingsService } from './performance-ratings.service';

jest.mock('../payroll/payroll-period-guard', () => ({
  markPayrollStaleForFinancialYear: jest.fn(async () => undefined),
}));

// Whether the acting reviewer covers the employee (their reporting line); set per test.
let inScope = true;
jest.mock('../common/dept-scope', () => ({
  ...jest.requireActual('../common/dept-scope'),
  inReviewerScope: jest.fn(async () => inScope),
}));

type Row = Record<string, any>;

function build(existing: Row | null, employee: Row) {
  const state: { rating: Row | null } = { rating: existing ? { id: 'r1', organizationId: 'org', ...existing } : null };
  const audit: Row[] = [];
  const prisma: Row = {
    user: { findFirst: async () => ({ organizationId: 'org', name: 'Asha', email: 'a@x.com', ...employee }) },
    payrollSettings: { findFirst: async () => ({ financialYearStartMonth: 4 }) },
    performanceRating: {
      findFirst: async () => (state.rating ? { ...state.rating } : null),
      findFirstOrThrow: async () => ({ ...state.rating }),
      create: async (a: Row) => {
        state.rating = { id: 'r1', organizationId: 'org', ...a.data };
        return { ...state.rating };
      },
      updateMany: async (a: Row) => {
        state.rating = { ...state.rating, ...a.data };
        return { count: 1 };
      },
    },
  };
  const svc = new PerformanceRatingsService(
    prisma as any,
    { create: async () => undefined } as any,
    { send: async () => undefined } as any,
    { log: async (e: Row) => audit.push(e) } as any,
    { logEvent: async () => undefined } as any,
    { renderOccasion: async () => ({ subject: 's', html: 'h' }) } as any,
  );
  return { svc, state, audit };
}

const FY = (() => {
  const d = new Date();
  const y = d.getUTCMonth() + 1 >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
})();
const dto = (rating: number) => ({ employeeId: 'e1', financialYear: FY, rating }) as any;
const manager = { id: 'm1', role: Role.MANAGER } as any;
const hr = { id: 'h1', role: Role.HR } as any;
const admin = { id: 'a1', role: Role.ADMIN } as any;

describe('PerformanceRatingsService.upsert', () => {
  beforeEach(() => { inScope = true; });

  it('a manager submits a rating for someone who reports to them: SUBMITTED, not yet published', async () => {
    const { svc, audit } = build(null, { id: 'e1', reportingManager: { role: Role.MANAGER } });
    const r = await svc.upsert(dto(4), manager, 'org');
    expect(r.status).toBe(PerformanceRatingStatus.SUBMITTED);
    expect(r.ratedById).toBe('m1');
    expect(audit.some((a) => a.action === 'PERFORMANCE_RATING_CREATED')).toBe(true);
  });

  it('a manager cannot rate someone outside their reporting line, or themselves', async () => {
    inScope = false;
    const a = build(null, { id: 'e1' });
    await expect(a.svc.upsert(dto(4), manager, 'org')).rejects.toBeInstanceOf(ForbiddenException);
    inScope = true;
    const b = build(null, { id: 'm1' });
    await expect(b.svc.upsert({ ...dto(4), employeeId: 'm1' }, manager, 'org')).rejects.toThrow('cannot rate yourself');
  });

  it('HR can rate an employee whose reporting manager is a manager (no longer blocked): published at once', async () => {
    const { svc } = build(null, { id: 'e1', reportingManager: { role: Role.MANAGER } });
    const r = await svc.upsert(dto(3), hr, 'org');
    expect(r.status).toBe(PerformanceRatingStatus.APPROVED);
  });

  it('HR changes a rating the manager submitted: it is published with the new rating, the manager stays the rater and HR is the approver', async () => {
    const { svc, audit } = build(
      { employeeId: 'e1', financialYear: FY, rating: 2, status: PerformanceRatingStatus.SUBMITTED, ratedById: 'm1' },
      { id: 'e1', reportingManager: { role: Role.MANAGER } },
    );
    const r = await svc.upsert(dto(5), hr, 'org');
    expect(r.rating).toBe(5);
    expect(r.status).toBe(PerformanceRatingStatus.APPROVED);
    expect(r.ratedById).toBe('m1');
    expect(r.approvedById).toBe('h1');
    const change = audit.find((a) => a.action === 'PERFORMANCE_RATING_CHANGED_BY_REVIEWER');
    expect(change?.details).toMatchObject({ previousRating: 2, previousStatus: PerformanceRatingStatus.SUBMITTED, newRating: 5 });
  });

  it('an Admin changes an already approved rating: stays approved, change is audited', async () => {
    const { svc, audit } = build(
      { employeeId: 'e1', financialYear: FY, rating: 3, status: PerformanceRatingStatus.APPROVED, ratedById: 'm1' },
      { id: 'e1' },
    );
    const r = await svc.upsert(dto(4), admin, 'org');
    expect(r.rating).toBe(4);
    expect(r.status).toBe(PerformanceRatingStatus.APPROVED);
    expect(audit.some((a) => a.action === 'PERFORMANCE_RATING_CHANGED_BY_REVIEWER')).toBe(true);
  });

  it('HR cannot rate themselves', async () => {
    const { svc } = build(null, { id: 'h1' });
    await expect(svc.upsert({ ...dto(4), employeeId: 'h1' }, hr, 'org')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
