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

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
  generatedPassword: string;
}
interface LeaveTypeBody {
  id: string;
  code: string;
}
interface GridResponse {
  employees: { id: string; name: string; employeeId: string }[];
  days: { day: number; dow: number; holidayName?: string }[];
  cells: Record<string, Record<number, string>>;
  hours: Record<string, Record<number, number>>;
}
interface BalanceEntry {
  employeeId: string;
  name: string;
  leaveBalances: {
    leaveTypeCode: string;
    leaveTypeName: string;
    credited: number;
    availed: number;
    closing: number;
  }[];
  compOffAvailable: number;
  wfhDaysUsed: number;
}
interface LeaveBalanceResponse {
  balances: {
    id: string;
    leaveTypeId: string;
    credited: number;
    availed: number;
    closing: number;
    leaveType: { id: string; name: string; code: string };
  }[];
  compOffAvailable: number;
}

const PASSWORD = 'TestPass123!';
const YEAR = 2026;
const MONTH = 8; // August — safely in the past relative to "today" (2026-09-02)

describe('Leave Tracker (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let managerId: string;
  let departmentId: string;
  let empAId: string;
  let empBId: string;
  let lateJoinerId: string;
  let outsideEmployeeId: string;
  let otherDepartmentId: string;
  let talLeaveTypeId: string;
  let compOffLeaveTypeId: string;

  function d(day: number): string {
    return `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

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
      organizationName: 'Leave Tracker E2E Org',
      name: 'Founder',
      email: 'leavetracker-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'leavetracker-e2e-admin@example.test',
        password: PASSWORD,
      });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'leavetracker-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'leavetracker-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Engineering', code: 'ENG' });
    departmentId = (dept.body as { id: string }).id;

    const otherDept = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Sales', code: 'SLS' });
    otherDepartmentId = (otherDept.body as { id: string }).id;

    const managerCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Eng Manager',
        email: 'leavetracker-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    managerId = (managerCreate.body as EmployeeCreateBody).employee.id;
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'leavetracker-e2e-manager@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empACreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Employee A',
        email: 'leavetracker-e2e-empa@example.test',
        departmentId,
        // Well before MONTH/YEAR below — a default (today's) joiningDate
        // would fall after the whole fixture month and suppress every
        // ABSENT backfill assertion this file makes.
        joiningDate: '2020-01-01',
      });
    empAId = (empACreate.body as EmployeeCreateBody).employee.id;

    const lateJoinerCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Late Joiner',
        email: 'leavetracker-e2e-latejoiner@example.test',
        departmentId,
        joiningDate: d(12), // mid-fixture-month — see the dedicated grid test.
      });
    lateJoinerId = (lateJoinerCreate.body as EmployeeCreateBody).employee.id;

    const empBCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Employee B',
        email: 'leavetracker-e2e-empb@example.test',
        departmentId,
      });
    empBId = (empBCreate.body as EmployeeCreateBody).employee.id;

    const outsideCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Outside Employee',
        email: 'leavetracker-e2e-outside@example.test',
        departmentId: otherDepartmentId,
      });
    outsideEmployeeId = (outsideCreate.body as EmployeeCreateBody).employee.id;

    const talType = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Test Annual Leave',
        code: 'TAL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 24,
        prorateOnJoining: false,
      });
    talLeaveTypeId = (talType.body as LeaveTypeBody).id;

    const leaveTypesList = await request(app.getHttpServer())
      .get('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`);
    compOffLeaveTypeId = (
      leaveTypesList.body as { data: LeaveTypeBody[] }
    ).data.find((t) => t.code === 'COMPOFF')!.id;

    // Seed a Holiday for Aug 8.
    await prisma.holiday.create({
      data: {
        organizationId: (
          await prisma.user.findFirstOrThrow({
            where: { id: empAId },
          })
        ).organizationId,
        name: 'Test Holiday',
        date: d(8),
        year: YEAR,
        departmentId: null,
      },
    });

    const organizationId = (
      await prisma.user.findFirstOrThrow({ where: { id: empAId } })
    ).organizationId;

    // Seed the Leave rows the comp-off/regular-leave Attendance cells key
    // off (a Leave.APPROVED row covering the date, joined to LeaveType).
    await prisma.leave.create({
      data: {
        organizationId,
        employeeId: empAId,
        leaveTypeId: talLeaveTypeId,
        startDate: d(6),
        endDate: d(6),
        isHalfDay: true,
        totalDays: 0.5,
        status: 'APPROVED',
      },
    });
    await prisma.leave.create({
      data: {
        organizationId,
        employeeId: empAId,
        leaveTypeId: compOffLeaveTypeId,
        startDate: d(7),
        endDate: d(7),
        totalDays: 1,
        status: 'APPROVED',
      },
    });
    await prisma.leave.create({
      data: {
        organizationId,
        employeeId: empAId,
        leaveTypeId: talLeaveTypeId,
        startDate: d(10),
        endDate: d(10),
        totalDays: 1,
        status: 'APPROVED',
      },
    });

    // Seed the Attendance grid: present, absent, WFH, half-day-with-
    // comp-off-leave, half-day-with-regular-leave (here full-day ON_LEAVE
    // with regular leave), holiday, weekly-off.
    await prisma.attendance.createMany({
      data: [
        {
          organizationId,
          employeeId: empAId,
          date: d(3),
          status: 'PRESENT',
          workArrangement: 'OFFICE',
          workDurationMinutes: 495, // 8.25h — see the `hours` map assertion.
        },
        {
          organizationId,
          employeeId: empAId,
          date: d(4),
          status: 'ABSENT',
        },
        {
          organizationId,
          employeeId: empAId,
          date: d(5),
          status: 'PRESENT',
          workArrangement: 'WFH',
        },
        {
          organizationId,
          employeeId: empAId,
          date: d(6),
          status: 'HALF_DAY',
        },
        {
          organizationId,
          employeeId: empAId,
          date: d(7),
          status: 'ON_LEAVE',
        },
        {
          organizationId,
          employeeId: empAId,
          date: d(8),
          status: 'HOLIDAY',
        },
        {
          organizationId,
          employeeId: empAId,
          date: d(9),
          status: 'WEEKLY_OFF',
        },
        {
          organizationId,
          employeeId: empAId,
          date: d(10),
          status: 'ON_LEAVE',
        },
        // Outside-department employee — must never show up in a MANAGER's
        // scoped grid.
        {
          organizationId,
          employeeId: outsideEmployeeId,
          date: d(3),
          status: 'PRESENT',
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "attendances", "leaves", "leave_balances", "leave_types", "holidays", "comp_offs", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  describe('GET /leave-tracker/grid', () => {
    it('derives the correct cell code for every seeded case (ADMIN, org-wide)', async () => {
      const res = await request(app.getHttpServer())
        .get('/leave-tracker/grid')
        .query({ month: MONTH, year: YEAR })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const body = res.body as GridResponse;

      const cells = body.cells[empAId];
      expect(cells[3]).toBe('PRESENT');
      // 495 minutes worked on day 3 -> 8.25h, rounded to 1 decimal -> 8.3.
      expect(body.hours[empAId]?.[3]).toBe(8.3);
      // No work duration recorded for day 5 (WFH) — omitted, not 0.
      expect(body.hours[empAId]?.[5]).toBeUndefined();
      expect(cells[4]).toBe('ABSENT');
      expect(cells[5]).toBe('WFH');
      expect(cells[6]).toBe('HALF_DAY');
      expect(cells[7]).toBe('COMP_OFF');
      expect(cells[8]).toBe('HOLIDAY');
      expect(cells[9]).toBe('WEEKLY_OFF');
      expect(cells[10]).toBe('ON_LEAVE');

      // No Attendance row exists for day 11 — a past weekday with nothing
      // recorded is backfilled to ABSENT, not left blank.
      expect(cells[11]).toBe('ABSENT');

      // Day 15 (a Saturday) also has no Attendance row, but it's a weekend
      // — must stay blank, never backfilled to ABSENT.
      expect(cells[15]).toBeUndefined();

      const day8 = body.days.find((day) => day.day === 8);
      expect(day8?.holidayName).toBe('Test Holiday');

      expect(body.employees.some((e) => e.id === empAId)).toBe(true);
      expect(body.employees.some((e) => e.id === outsideEmployeeId)).toBe(true);
    });

    it('MANAGER is scoped to only their own department, even with no departmentId param', async () => {
      const res = await request(app.getHttpServer())
        .get('/leave-tracker/grid')
        .query({ month: MONTH, year: YEAR })
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const body = res.body as GridResponse;
      const ids = body.employees.map((e) => e.id);
      expect(ids).toContain(empAId);
      expect(ids).toContain(empBId);
      // The manager themself is also in their own department.
      expect(ids).toContain(managerId);
      expect(ids).not.toContain(outsideEmployeeId);
    });

    it('MANAGER passing a departmentId that is not their own is rejected', async () => {
      await request(app.getHttpServer())
        .get('/leave-tracker/grid')
        .query({ month: MONTH, year: YEAR, departmentId: otherDepartmentId })
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
    });

    it("MANAGER passing their own departmentId is accepted (doesn't widen or narrow)", async () => {
      const res = await request(app.getHttpServer())
        .get('/leave-tracker/grid')
        .query({ month: MONTH, year: YEAR, departmentId })
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const ids = (res.body as GridResponse).employees.map((e) => e.id);
      expect(ids).toContain(empAId);
    });

    it('ADMIN can narrow the org-wide grid to one department', async () => {
      const res = await request(app.getHttpServer())
        .get('/leave-tracker/grid')
        .query({ month: MONTH, year: YEAR, departmentId: otherDepartmentId })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const ids = (res.body as GridResponse).employees.map((e) => e.id);
      expect(ids).toContain(outsideEmployeeId);
      expect(ids).not.toContain(empAId);
    });

    it('never backfills ABSENT onto today or a future day', async () => {
      const now = new Date();
      const res = await request(app.getHttpServer())
        .get('/leave-tracker/grid')
        .query({ month: now.getUTCMonth() + 1, year: now.getUTCFullYear() })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const cells = (res.body as GridResponse).cells[empAId] ?? {};
      // No Attendance rows exist for empA in the current month at all — if
      // today/future backfilling ever leaked in, this would start failing.
      expect(cells[now.getUTCDate()]).toBeUndefined();
      const lastDay = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
      ).getUTCDate();
      if (lastDay > now.getUTCDate()) {
        expect(cells[lastDay]).toBeUndefined();
      }
    });

    it("never backfills ABSENT before an employee's own joining date", async () => {
      const res = await request(app.getHttpServer())
        .get('/leave-tracker/grid')
        .query({ month: MONTH, year: YEAR })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const cells = (res.body as GridResponse).cells[lateJoinerId] ?? {};
      // Late Joiner's joiningDate is Aug 12 — day 11 (a Tuesday, before
      // they joined) must stay blank, day 13 (a Thursday, after) with no
      // Attendance row backfills to ABSENT same as any other employee's.
      expect(cells[11]).toBeUndefined();
      expect(cells[13]).toBe('ABSENT');
    });
  });

  describe('GET /leave-tracker/balances', () => {
    it("matches GET /leaves/balance's numbers for the same employee", async () => {
      const trackerRes = await request(app.getHttpServer())
        .get('/leave-tracker/balances')
        .query({ year: YEAR })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const trackerBalances = trackerRes.body as BalanceEntry[];
      const empAEntry = trackerBalances.find((e) => e.employeeId === empAId);
      expect(empAEntry).toBeDefined();

      const directRes = await request(app.getHttpServer())
        .get('/leaves/balance')
        .query({ employeeId: empAId, year: YEAR })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const direct = directRes.body as LeaveBalanceResponse;

      const directTal = direct.balances.find((b) => b.leaveType.code === 'TAL');
      const trackerTal = empAEntry!.leaveBalances.find(
        (b) => b.leaveTypeCode === 'TAL',
      );
      expect(trackerTal).toBeDefined();
      expect(trackerTal!.credited).toBe(directTal!.credited);
      expect(trackerTal!.availed).toBe(directTal!.availed);
      expect(trackerTal!.closing).toBe(directTal!.closing);
      expect(empAEntry!.compOffAvailable).toBe(direct.compOffAvailable);
    });

    it('counts WFH days from Attendance for the requested year', async () => {
      const res = await request(app.getHttpServer())
        .get('/leave-tracker/balances')
        .query({ year: YEAR })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const entry = (res.body as BalanceEntry[]).find(
        (e) => e.employeeId === empAId,
      );
      expect(entry?.wfhDaysUsed).toBe(1);
    });

    it('MANAGER is scoped to only their own department', async () => {
      const res = await request(app.getHttpServer())
        .get('/leave-tracker/balances')
        .query({ year: YEAR })
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const ids = (res.body as BalanceEntry[]).map((e) => e.employeeId);
      expect(ids).toContain(empAId);
      expect(ids).not.toContain(outsideEmployeeId);
    });

    it('MANAGER passing a departmentId that is not their own is rejected', async () => {
      await request(app.getHttpServer())
        .get('/leave-tracker/balances')
        .query({ year: YEAR, departmentId: otherDepartmentId })
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
    });
  });
});
