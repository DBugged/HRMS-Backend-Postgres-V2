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
import { daysUntilNextOccurrence } from '../src/dashboard/dashboard-date-math';

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
  generatedPassword: string;
}

const PASSWORD = 'TestPass123!';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function offsetDate(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
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
  let anniversaryJoinMonth: number;
  let anniversaryJoinDay: number;

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
    // verbatim from the old system) always rolls an exact-same-day match to
    // next year, since "next" is midnight and "today" already has a
    // time-of-day past midnight — a same-day anniversary would silently
    // roll outside the 30-day window. +5 days avoids that entirely.
    const anniversaryJoin = new Date();
    anniversaryJoin.setDate(anniversaryJoin.getDate() + 5);
    anniversaryJoinMonth = anniversaryJoin.getMonth() + 1;
    anniversaryJoinDay = anniversaryJoin.getDate();
    anniversaryJoin.setFullYear(anniversaryJoin.getFullYear() - 2);
    await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Anniversary Employee',
        email: 'dash-e2e-anniv@example.test',
        joiningDate: anniversaryJoin.toISOString().slice(0, 10),
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
        name: 'Earned Leave',
        code: 'EL',
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
        startDate: offsetDate(10),
        endDate: offsetDate(11),
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
      teamAttendanceToday: { employeeId: string }[];
    };
    expect(body.teamSize).toBeGreaterThanOrEqual(1);
    expect(
      body.teamAttendanceToday.some((r) => r.employeeId === employeeId),
    ).toBe(true);
  });

  it("ADMIN (no department) is scoped to other no-department users, same as the old system's where:{department:null} behavior", async () => {
    const noDeptCount = await prisma.user.count({
      where: { organizationId, departmentId: null },
    });
    const res = await request(app.getHttpServer())
      .get('/dashboard/department-head')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((res.body as { teamSize: number }).teamSize).toBe(noDeptCount);
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

  it('ADMIN sees the executive dashboard with headcount + the seeded work anniversary', async () => {
    const res = await request(app.getHttpServer())
      .get('/dashboard/executive')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      headcount: { currentActiveHeadcount: number; trend: unknown[] };
      upcomingAnniversaries: {
        name: string;
        years: number;
        daysAway: number;
      }[];
    };
    expect(body.headcount.currentActiveHeadcount).toBeGreaterThanOrEqual(5);
    expect(body.headcount.trend).toHaveLength(12);
    const anniv = body.upcomingAnniversaries.find(
      (a) => a.name === 'Anniversary Employee',
    );
    const expectedDaysAway = daysUntilNextOccurrence(
      anniversaryJoinMonth,
      anniversaryJoinDay,
      new Date(),
    );
    expect(anniv).toBeDefined();
    expect(anniv?.years).toBe(2);
    expect(anniv?.daysAway).toBe(expectedDaysAway);
  });
});
