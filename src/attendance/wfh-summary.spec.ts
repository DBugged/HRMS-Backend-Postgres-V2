import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AttendanceService } from './attendance.service';

type Row = Record<string, any>;

// The service's only dependency here is the scoped Prisma client: an in-memory attendance table and org.
function build(rows: Row[], org: Row = {}) {
  const match = (r: Row, w: Row) =>
    Object.entries(w).every(([k, v]) => {
      if (v && typeof v === 'object') {
        const c = v as Row;
        if ('gte' in c && !(r[k] >= c.gte)) return false;
        if ('lte' in c && !(r[k] <= c.lte)) return false;
        if ('gt' in c && !(r[k] > c.gt)) return false;
        return true;
      }
      return r[k] === v;
    });
  const prisma: Row = {
    organization: {
      findFirst: async () => ({
        timezone: 'Asia/Kolkata',
        enableWFH: true,
        leaveYearStartMonth: 1,
        leaveYearAnchorYear: null,
        ...org,
      }),
    },
    user: {
      findFirst: async (a: { where: Row }) =>
        a.where.id === 'e2' ? { id: 'e2', departmentId: 'd1' } : null,
    },
    attendance: {
      count: async (a: { where: Row }) =>
        rows.filter((r) => match(r, a.where)).length,
    },
  };
  const service = Object.create(
    AttendanceService.prototype,
  ) as AttendanceService;
  (service as unknown as Row).scopedPrisma = prisma;
  return service;
}

const wfh = (employeeId: string, date: string, status: string): Row => ({
  organizationId: 'org',
  employeeId,
  date,
  workArrangement: 'WFH',
  workArrangementStatus: status,
});
const employee = { id: 'e1', role: 'EMPLOYEE', departmentId: 'd1' } as never;
const hr = { id: 'h1', role: 'HR', departmentId: null } as never;

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-10-21T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('WFH summary', () => {
  const rows = [
    wfh('e1', '2026-02-10', 'APPROVED'), // earlier this year
    wfh('e1', '2026-10-05', 'APPROVED'), // this month, past
    wfh('e1', '2026-10-21', 'APPROVED'), // today counts as used
    wfh('e1', '2026-10-28', 'APPROVED'), // still to come
    wfh('e1', '2026-11-03', 'PENDING'),
    wfh('e1', '2026-10-06', 'REJECTED'), // never counted
    wfh('e1', '2025-12-30', 'APPROVED'), // last year
    wfh('e2', '2026-10-05', 'APPROVED'), // someone else
  ];

  it("counts an employee's own approved days used this year and this month, the ones to come, and the pending ones", async () => {
    const r = await build(rows).getWfhSummary(undefined, employee, 'org');
    expect(r).toEqual({
      enabled: true,
      yearStart: '2026-01-01',
      yearEnd: '2026-12-31',
      usedThisYear: 3,
      usedThisMonth: 2,
      upcoming: 1,
      pending: 1,
    });
  });

  it('says so when Work From Home is switched off for the company', async () => {
    const r = await build(rows, { enableWFH: false }).getWfhSummary(
      undefined,
      employee,
      'org',
    );
    expect(r.enabled).toBe(false);
  });

  it("HR can read another employee's; an employee cannot; an unknown id is not found", async () => {
    const svc = build(rows);
    expect((await svc.getWfhSummary('e2', hr, 'org')).usedThisYear).toBe(1);
    await expect(
      svc.getWfhSummary('e2', employee, 'org'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getWfhSummary('nobody', hr, 'org')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
