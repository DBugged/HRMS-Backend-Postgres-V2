import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AttendanceStatus } from '@prisma/client';

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
  generatedPassword: string;
}

const PASSWORD = 'TestPass123!';

// toISOString() converts through UTC — for a machine running ahead of UTC
// (e.g. IST, UTC+5:30), any local time before the offset rolls past
// midnight makes the UTC date one day behind the local date, silently
// shifting this by a day. Format from local Y/M/D components instead,
// same fix already applied to backend-v2/scripts/migrate-legacy-data.js
// for the identical bug.
function localDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr() {
  return localDateStr(new Date());
}

function offsetDate(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

// Leave day-counts exclude weekly-offs/holidays (sandwichLeaveApplies is
// false by default), so a leave range landing entirely on a weekend is now
// rejected. Leave ranges below start on a Monday >= minDays out instead of
// a raw "today + N" that could fall on Sat/Sun depending on the run date.
function mondayOffset(minDays: number) {
  const d = new Date();
  d.setDate(d.getDate() + minDays);
  return minDays + ((1 - d.getDay() + 7) % 7);
}

describe('Dashboard (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let employeeToken: string;
  let employeeId: string;
  let organizationId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    await request(app.getHttpServer()).post('/auth/register').send({
      organizationName: 'Dashboard E2E Org',
      name: 'Founder',
      email: 'dash-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'dash-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'dash-e2e-admin@example.test' },
    });
    organizationId = admin.organizationId;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'dash-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'dash-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Engineering', code: 'ENG' });
    const departmentId = (dept.body as { id: string }).id;

    const managerCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Eng Manager',
        email: 'dash-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'dash-e2e-manager@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'dash-e2e-emp@example.test',
        departmentId,
      });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;

    // Joined before the sample dates used below: a claim / comp-off / record is not accepted for a day before the
    // person joined.
    await prisma.user.updateMany({
      where: { email: { startsWith: 'dash-e2e-emp' } },
      data: { joiningDate: new Date('2020-01-01T00:00:00.000Z') },
    });
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'dash-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    // A second employee whose join-date anniversary falls 5 days from now
    // (2 years ago) -> shows up as an upcoming work anniversary. Not
    // exactly today: daysUntilNextOccurrence's `next < today` check (ported
    // verbatim from the original release) always rolls an exact-same-day match to
    // next year, since "next" is midnight and "today" already has a
    // time-of-day past midnight — a same-day anniversary would silently
    // roll outside the 30-day window. +5 days avoids that entirely.
    const anniversaryJoin = new Date();
    anniversaryJoin.setDate(anniversaryJoin.getDate() + 5);
    anniversaryJoin.setFullYear(anniversaryJoin.getFullYear() - 2);
    await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Anniversary Employee',
        email: 'dash-e2e-anniv@example.test',
        joiningDate: localDateStr(anniversaryJoin),
      });

    // A third employee whose dateOfBirth (in personalData) falls 6 days
    // from now -> shows up as an upcoming birthday. Same +N-days rationale
    // as the anniversary employee above (avoids the same-day edge case in
    // daysUntilNextOccurrence).
    const birthday = new Date();
    birthday.setDate(birthday.getDate() + 6);
    birthday.setFullYear(birthday.getFullYear() - 30);
    const birthdayEmpCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Birthday Employee', email: 'dash-e2e-bday@example.test' });
    const birthdayEmpId = (birthdayEmpCreate.body as EmployeeCreateBody)
      .employee.id;
    await request(app.getHttpServer())
      .patch(`/employees/${birthdayEmpId}/personal-data`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        personalData: { dateOfBirth: localDateStr(birthday) },
      });

    await prisma.attendance.create({
      data: {
        organizationId,
        employeeId,
        date: todayStr(),
        status: AttendanceStatus.PRESENT,
        source: 'FACE_API',
      },
    });

    const leaveType = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Test Annual Leave',
        code: 'TAL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 24,
        prorateOnJoining: false,
      });
    const leaveTypeId = (leaveType.body as { id: string }).id;

    await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: leaveTypeId,
        startDate: offsetDate(mondayOffset(10) + 0),
        endDate: offsetDate(mondayOffset(10) + 1),
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/holidays')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Upcoming Holiday', date: '2099-12-25' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/reimbursements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ amount: 1000, claimDate: '2026-06-01' })
      .expect(201);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "reimbursements", "holidays", "leaves", "leave_balances", "leave_types", "attendances", "payroll_runs", "payroll_settings", "statutory_config_versions", "tax_slab_configs", "employee_tax_declarations", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403 on /hr and /executive', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/dashboard/hr')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
    await request(server)
      .get('/dashboard/executive')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('ADMIN sees the HR dashboard with correct aggregates', async () => {
    const res = await request(app.getHttpServer())
      .get('/dashboard/hr')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      totalEmployees: number;
      attendanceSummary: { presentToday: number };
      pendingApprovals: { leaves: number };
      reimbursementsSummary: { pendingClaims: number; amountPending: number };
      upcomingHolidays: { name: string }[];
    };
    expect(body.totalEmployees).toBeGreaterThanOrEqual(5);
    expect(body.attendanceSummary.presentToday).toBeGreaterThanOrEqual(1);
    expect(body.pendingApprovals.leaves).toBeGreaterThanOrEqual(1);
    expect(body.reimbursementsSummary.pendingClaims).toBeGreaterThanOrEqual(1);
    expect(body.reimbursementsSummary.amountPending).toBeGreaterThanOrEqual(
      1000,
    );
    expect(
      body.upcomingHolidays.some((h) => h.name === 'Upcoming Holiday'),
    ).toBe(true);
  });

  it('Department Leave counts only the days of a leave that fall in this month', async () => {
    const dashboard = async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/hr')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      return (
        res.body as { departmentLeaveSummary: { days: number }[] }
      ).departmentLeaveSummary.reduce((n, d) => n + d.days, 0);
    };
    const before = await dashboard();
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + 1;
    const pad = (n: number) => String(n).padStart(2, '0');
    const prevMonthEnd = new Date(Date.UTC(y, m - 1, 0));
    const leaveType = await prisma.leaveType.findFirstOrThrow({
      where: { organizationId },
    });
    // Three days of last month (28th onwards at worst) and the first six of this one: 9 calendar days, 6 this month.
    const startDay = prevMonthEnd.getUTCDate() - 2;
    await prisma.leave.create({
      data: {
        organizationId,
        employeeId,
        leaveTypeId: leaveType.id,
        startDate: `${prevMonthEnd.getUTCFullYear()}-${pad(prevMonthEnd.getUTCMonth() + 1)}-${pad(startDay)}`,
        endDate: `${y}-${pad(m)}-06`,
        totalDays: 9,
        status: 'APPROVED',
      },
    });
    const after = await dashboard();
    expect(after - before).toBe(6);
  });

  it('HR sees a 12-month payroll cost summary chart, defaulting to this_year', async () => {
    const res = await request(app.getHttpServer())
      .get('/dashboard/hr/payroll-cost-summary')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    const body = res.body as { range: string; chart: { month: number }[] };
    expect(body.range).toBe('this_year');
    expect(body.chart).toHaveLength(12);
  });

  it("MANAGER's department-head dashboard is scoped to their own department", async () => {
    const res = await request(app.getHttpServer())
      .get('/dashboard/department-head')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const body = res.body as {
      teamSize: number;
      pendingItems: unknown[];
      leaveTrends: unknown[];
      teamLeaveBalances: unknown[];
    };
    // The team is the manager's own department (it includes the e2e employee). The old per-day
    // teamAttendanceToday list is gone from the response; pending work is surfaced as pendingItems.
    expect(body.teamSize).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.pendingItems)).toBe(true);
    expect(Array.isArray(body.leaveTrends)).toBe(true);
    expect(Array.isArray(body.teamLeaveBalances)).toBe(true);
  });

  it("the manager's team size counts active department members only", async () => {
    const teamSize = async () =>
      (
        (
          await request(app.getHttpServer())
            .get('/dashboard/department-head')
            .set('Authorization', `Bearer ${managerToken}`)
            .expect(200)
        ).body as { teamSize: number }
      ).teamSize;
    const manager = await prisma.user.findFirstOrThrow({
      where: { organizationId, role: 'MANAGER' },
    });
    const before = await teamSize();
    const created = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Team Member',
        email: 'dash-team-member@example.test',
        joiningDate: '2026-01-01',
        departmentId: manager.departmentId,
      })
      .expect(201);
    const memberId = (created.body as { employee: { id: string } }).employee.id;
    expect(await teamSize()).toBe(before + 1);
    await prisma.user.update({
      where: { id: memberId },
      data: { isActive: false },
    });
    expect(await teamSize()).toBe(before);
  });

  it('Low Leave Balance lists active employees only and ignores one-off event-based leave', async () => {
    const year = (
      await prisma.leaveBalance.findFirstOrThrow({ where: { organizationId } })
    ).year;
    const yearly = await prisma.leaveType.findFirstOrThrow({
      where: {
        organizationId,
        countInTotalBalance: true,
        allocationType: { not: 'EVENT_BASED' },
      },
    });
    const event = await prisma.leaveType.findFirstOrThrow({
      where: { organizationId, allocationType: 'EVENT_BASED' },
    });
    const mk = async (email: string) =>
      (
        (
          await request(app.getHttpServer())
            .post('/employees')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
              name: email.split('@')[0],
              email,
              joiningDate: '2026-01-01',
            })
            .expect(201)
        ).body as { employee: { id: string } }
      ).employee.id;
    const low = await mk('dash-low-active@example.test');
    const gone = await mk('dash-low-gone@example.test');
    const eventOnly = await mk('dash-low-event@example.test');
    const row = (employeeId: string, leaveTypeId: string, closing: number) =>
      prisma.leaveBalance.create({
        data: { organizationId, employeeId, leaveTypeId, year, closing },
      });
    await row(low, yearly.id, 1);
    await row(gone, yearly.id, 1);
    await row(eventOnly, event.id, 1);
    await prisma.user.update({
      where: { id: gone },
      data: { isActive: false },
    });
    const res = await request(app.getHttpServer())
      .get('/dashboard/hr')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const ids = (
      res.body as { lowBalanceEmployees: { id: string }[] }
    ).lowBalanceEmployees.map((e) => e.id);
    expect(ids).toContain(low);
    expect(ids).not.toContain(gone);
    expect(ids).not.toContain(eventOnly);
  });

  it("ADMIN (no department) is scoped to other no-department users, same as the old system's where:{department:null} behavior", async () => {
    // Active people only (a deactivated colleague is not part of the team any more).
    const noDeptCount = await prisma.user.count({
      where: { organizationId, departmentId: null, isActive: true },
    });
    const res = await request(app.getHttpServer())
      .get('/dashboard/department-head')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((res.body as { teamSize: number }).teamSize).toBe(noDeptCount);
  });

  it("HR dashboard splits Present from Checked in: a bare punch-in is not 'present' yet", async () => {
    const counts = async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/hr')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      return (
        res.body as {
          attendanceSummary: { presentToday: number; checkedInToday: number };
        }
      ).attendanceSummary;
    };
    const before = await counts();
    const mk = async (email: string) =>
      (
        (
          await request(app.getHttpServer())
            .post('/employees')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
              name: email.split('@')[0],
              email,
              joiningDate: '2026-01-01',
            })
            .expect(201)
        ).body as { employee: { id: string } }
      ).employee.id;
    const inOnly = await mk('dash-in-only@example.test');
    const finished = await mk('dash-finished@example.test');
    const nine = new Date();
    nine.setUTCHours(4, 0, 0, 0);
    const five = new Date(nine.getTime() + 8 * 3_600_000);
    const row = (employeeId: string, outTime: Date | null) =>
      prisma.attendance.create({
        data: {
          organizationId,
          employeeId,
          date: todayStr(),
          status: AttendanceStatus.PRESENT,
          source: 'FACE_API',
          inTime: nine,
          outTime,
        },
      });
    await row(inOnly, null);
    await row(finished, five);
    const after = await counts();
    expect(after.checkedInToday - before.checkedInToday).toBe(1);
    expect(after.presentToday - before.presentToday).toBe(1);

    // The attendance list says the same per day, so the apps can label it 'Checked in'.
    const flag = async (employeeId: string) => {
      const res = await request(app.getHttpServer())
        .get('/attendance')
        .query({ employeeId, from: todayStr(), to: todayStr() })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      return (res.body as { data: { inProgress: boolean }[] }).data[0]
        ?.inProgress;
    };
    expect(await flag(inOnly)).toBe(true);
    expect(await flag(finished)).toBe(false);
  });

  it('payroll cost summary counts final (locked) payroll only, not runs still being worked on', async () => {
    const cost = async (month: number, year: number) =>
      (
        (
          await request(app.getHttpServer())
            .get('/dashboard/hr/payroll-cost-summary')
            .query({ range: 'this_year' })
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(200)
        ).body as {
          chart: { month: number; year: number; netPay: number }[];
        }
      ).chart.find((c) => c.month === month && c.year === year)?.netPay ?? 0;
    // Two months of the current year (inside any financial year that contains today's date is not guaranteed for old
    // months, so use the current and previous month, which are always in this_year).
    const now = new Date();
    const cur = { month: now.getUTCMonth() + 1, year: now.getUTCFullYear() };
    const prev =
      cur.month === 1
        ? { month: 12, year: cur.year - 1 }
        : { month: cur.month - 1, year: cur.year };
    const mk = (
      m: { month: number; year: number },
      status: 'CALCULATED' | 'LOCKED',
    ) =>
      prisma.payrollRun.create({
        data: {
          organizationId,
          employeeId,
          month: m.month,
          year: m.year,
          status,
          netPay: 1234,
        },
      });
    const beforeOpen = await cost(cur.month, cur.year);
    const beforeFinal = await cost(prev.month, prev.year);
    await mk(cur, 'CALCULATED');
    await mk(prev, 'LOCKED');
    expect(await cost(cur.month, cur.year)).toBe(beforeOpen);
    expect(await cost(prev.month, prev.year)).toBe(beforeFinal + 1234);
    // Removed again so the employee dashboard test that follows still sees no payslip.
    await prisma.payrollRun.deleteMany({
      where: { organizationId, employeeId, netPay: 1234 },
    });
  });

  it('EMPLOYEE cannot read the department-head dashboard', async () => {
    await request(app.getHttpServer())
      .get('/dashboard/department-head')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it("EMPLOYEE sees their own employee dashboard with today's attendance counted", async () => {
    const res = await request(app.getHttpServer())
      .get('/dashboard/employee')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const body = res.body as {
      attendanceSummary: Record<string, number>;
      compOffAvailable: number;
      payrollSnapshot: unknown;
      leaveBalances: unknown[];
    };
    expect(body.attendanceSummary.PRESENT).toBeGreaterThanOrEqual(1);
    expect(body.compOffAvailable).toBe(0);
    expect(body.payrollSnapshot).toBeNull();
  });

  it('EMPLOYEE dashboard rolls up pending requests, reimbursements, active loan, and tax declaration status', async () => {
    // beforeAll already applied one PENDING leave AND one PENDING ₹1000
    // reimbursement for this employee (used by the HR-dashboard
    // reimbursement-summary test above) — the counts/amounts below are
    // asserted as deltas against that baseline rather than exact totals.
    const baseline = await request(app.getHttpServer())
      .get('/dashboard/employee')
      .set('Authorization', `Bearer ${employeeToken}`)
      .then(
        (r) =>
          r.body as {
            pendingRequests: { reimbursement: number };
            reimbursements: { pendingCount: number; pendingAmount: number };
          },
      );

    await prisma.reimbursement.create({
      data: {
        organizationId,
        employeeId,
        category: 'TRAVEL',
        amount: 500,
        claimDate: todayStr(),
        status: 'PENDING',
      },
    });
    await prisma.loan.create({
      data: {
        organizationId,
        employeeId,
        loanType: 'LOAN',
        principal: 10000,
        interestRate: 0,
        tenureMonths: 5,
        emiAmount: 2000,
        startMonth: new Date().getMonth() + 1,
        startYear: new Date().getFullYear(),
        outstandingBalance: 8000,
        status: 'ACTIVE',
      },
    });
    await request(app.getHttpServer())
      .post('/tax-declarations')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ financialYear: '2026-27', section80C: 10000 })
      .expect(201);
    await prisma.compOff.create({
      data: {
        organizationId,
        employeeId,
        earnedForDate: todayStr(),
        reason: 'Weekend work',
        status: 'PENDING',
      },
    });

    const res = await request(app.getHttpServer())
      .get('/dashboard/employee')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const body = res.body as {
      pendingRequests: {
        leave: number;
        reimbursement: number;
        loan: number;
        regularization: number;
        compOff: number;
      };
      reimbursements: {
        recent: { id: string }[];
        pendingCount: number;
        pendingAmount: number;
      };
      activeLoan: { outstandingBalance: number; emiAmount: number } | null;
      taxDeclaration: { financialYear: string; status: string | null };
    };
    expect(body.pendingRequests.leave).toBeGreaterThanOrEqual(1);
    expect(body.pendingRequests.reimbursement).toBe(
      baseline.pendingRequests.reimbursement + 1,
    );
    expect(body.pendingRequests.loan).toBe(0); // seeded ACTIVE, not PENDING
    expect(body.pendingRequests.compOff).toBeGreaterThanOrEqual(1);
    expect(body.reimbursements.pendingCount).toBe(
      baseline.reimbursements.pendingCount + 1,
    );
    expect(body.reimbursements.pendingAmount).toBe(
      baseline.reimbursements.pendingAmount + 500,
    );
    expect(body.reimbursements.recent.length).toBeGreaterThanOrEqual(1);
    expect(body.activeLoan?.outstandingBalance).toBe(8000);
    expect(body.activeLoan?.emiAmount).toBe(2000);
    expect(body.taxDeclaration.status).toBe('DRAFT');
  });

  it('a pending regularization in the approvals list shows the actual punch and the requested times', async () => {
    await prisma.attendance.create({
      data: {
        organizationId,
        employeeId,
        date: '2026-06-02',
        status: 'PRESENT',
        source: 'FACE_API',
        inTime: new Date('2026-06-02T05:30:00.000Z'),
        outTime: new Date('2026-06-02T13:00:00.000Z'),
        regularization: {
          requested: true,
          reason: 'Forgot to punch',
          requestedInTime: '2026-06-02T04:30:00.000Z',
          requestedOutTime: '2026-06-02T13:30:00.000Z',
          status: 'pending',
          reviewedBy: null,
          reviewedAt: null,
          reviewComments: '',
        },
      },
    });
    const res = await request(app.getHttpServer())
      .get('/dashboard/hr')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    const item = (
      res.body as {
        pendingItems: { type: string; date: string; summary: string }[];
      }
    ).pendingItems.find(
      (i) => i.type === 'REGULARIZATION' && i.date === '2026-06-02',
    );
    expect(item?.summary).toMatch(
      /^Attendance regularization \(actual .+ - .+; requested .+ - .+\)$/,
    );
    expect(item?.summary).not.toMatch(/no punch/);
  });

  it('ADMIN sees the executive dashboard with headcount + the seeded work anniversary + birthday', async () => {
    const res = await request(app.getHttpServer())
      .get('/dashboard/executive')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      headcount: {
        currentActiveHeadcount: number;
        rows: unknown[];
        totalJoiners: number;
        totalLeavers: number;
        attritionRatePercent: number;
      };
      upcomingBirthdays: { name: string; daysAway: number }[];
      upcomingAnniversaries: {
        name: string;
        years: number;
        daysAway: number;
      }[];
    };
    expect(body.headcount.currentActiveHeadcount).toBeGreaterThanOrEqual(6);
    expect(body.headcount.rows).toHaveLength(12);
    expect(body.headcount.totalJoiners).toEqual(expect.any(Number));
    expect(body.headcount.totalLeavers).toEqual(expect.any(Number));
    expect(body.headcount.attritionRatePercent).toEqual(expect.any(Number));

    const anniv = body.upcomingAnniversaries.find(
      (a) => a.name === 'Anniversary Employee',
    );
    // Seeded exactly 5 calendar days ahead: the count is whole calendar days from the organisation's today, whatever the
    // time of day (it used to depend on the clock time and could read one day short in the afternoon).
    expect(anniv).toBeDefined();
    expect(anniv?.years).toBe(2);
    expect(anniv?.daysAway).toBe(5);

    const bday = body.upcomingBirthdays.find(
      (b) => b.name === 'Birthday Employee',
    );
    expect(bday).toBeDefined();
    expect(bday?.daysAway).toBe(6);
  });

  describe('pending counts (sidebar badges)', () => {
    type Counts = Record<string, number>;
    const get = (token: string) =>
      request(app.getHttpServer())
        .get('/dashboard/pending-counts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

    it('an employee gets zeros; the total is the sum of the queues', async () => {
      const res = await get(employeeToken);
      const body = res.body as Counts;
      expect(body.total).toBe(0);
      expect(body.leaves).toBe(0);
      const hr = (await get(hrToken)).body as Counts;
      const { total, ...queues } = hr;
      expect(total).toBe(Object.values(queues).reduce((a, b) => a + b, 0));
    });

    it('the count agrees with the Approvals list behind it (HR and manager)', async () => {
      // The list is capped at 10 per type, so compare whenever it is not capped; the count may be larger only if capped.
      const hrCounts = (await get(hrToken)).body as Counts;
      const hrList = await request(app.getHttpServer())
        .get('/dashboard/hr')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const hrItems = (hrList.body as { pendingItems: { type: string }[] })
        .pendingItems;
      expect(hrCounts.total).toBeGreaterThanOrEqual(hrItems.length);
      if (hrItems.length < 10) expect(hrCounts.total).toBe(hrItems.length);

      const mgrCounts = (await get(managerToken)).body as Counts;
      const mgrList = await request(app.getHttpServer())
        .get('/dashboard/department-head')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const mgrItems = (mgrList.body as { pendingItems: { type: string }[] })
        .pendingItems;
      expect(mgrCounts.total).toBeGreaterThanOrEqual(mgrItems.length);
      if (mgrItems.length < 10) expect(mgrCounts.total).toBe(mgrItems.length);
      // A manager never carries the HR-only queues.
      expect(
        mgrCounts.resignations +
          mgrCounts.loans +
          mgrCounts.encashments +
          mgrCounts.reimbursements,
      ).toBe(0);
    });
  });
});
