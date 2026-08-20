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
import { PRISMA_CLIENT } from '../src/prisma/prisma.module';
import type { ExtendedPrismaClient } from '../src/prisma/prisma.module';
import { AttendanceService } from '../src/attendance/attendance.service';

interface AuthBody {
  accessToken: string;
}
interface PunchIngestBody {
  punch: { id: string; source: string };
  attendance: { id: string; status: string; inTime: string; outTime: string };
}
interface EmployeeCreateBody {
  employee: { id: string; employeeId: string };
  generatedPassword: string;
}

const PASSWORD = 'TestPass123!';

function offsetDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The 3 fixed National Holidays auto-seeded on every org (see
// HolidaysService.seedDefaults) — same month/day every year.
const FIXED_NATIONAL_HOLIDAYS = new Set(['01-26', '08-15', '10-02']);

// Like offsetDate, but nudges forward a day at a time past any date that
// would land on one of the fixed National Holidays — for tests asserting
// a real working-day attendance status (PRESENT/ABSENT/etc.), where a
// plain offsetDate() would otherwise flip to HOLIDAY depending on what day
// the suite happens to run.
function offsetDateAvoidingHolidays(days: number): string {
  let d = days;
  let date = offsetDate(d);
  while (FIXED_NATIONAL_HOLIDAYS.has(date.slice(5))) {
    d += 1;
    date = offsetDate(d);
  }
  return date;
}

// Finds the next date (from a UTC anchor) matching the given getUTCDay()
// value, so weekly-off tests aren't flaky depending on when the suite runs.
function nextWeekday(targetDay: number, fromOffsetDays: number): string {
  let offset = fromOffsetDays;
  while (true) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    if (d.getUTCDay() === targetDay) return d.toISOString().slice(0, 10);
    offset += 1;
  }
}

describe('Attendance (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let scopedPrisma: ExtendedPrismaClient;
  let attendanceService: AttendanceService;

  let organizationId: string;
  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
  let employeeId: string;
  let employeeHumanId: string;
  let noDeptEmployeeToken: string;
  let noDeptEmployeeId: string;
  let workLocationId: string;
  let departmentId: string;

  const OFFICE_LAT = 19.076;
  const OFFICE_LNG = 72.8777;
  const FAR_LAT = 19.5;
  const FAR_LNG = 73.5;

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
    scopedPrisma = app.get(PRISMA_CLIENT);
    attendanceService = app.get(AttendanceService);

    await request(app.getHttpServer()).post('/auth/register').send({
      organizationName: 'Attendance E2E Org',
      name: 'Founder',
      email: 'att-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'att-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'att-e2e-admin@example.test' },
    });
    organizationId = admin.organizationId;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'att-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'att-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Engineering', code: 'ENG' });
    departmentId = (dept.body as { id: string }).id;

    const workLocation = await request(app.getHttpServer())
      .post('/work-locations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HQ Mumbai',
        latitude: OFFICE_LAT,
        longitude: OFFICE_LNG,
        radiusMeters: 100,
      });
    workLocationId = (workLocation.body as { id: string }).id;

    // No update endpoint exists for Department's shift-config/geofence
    // fields yet (out of scope for this batch) — set directly via Prisma.
    await prisma.department.update({
      where: { id: departmentId },
      data: { workLocationId },
    });

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Geo Employee',
        email: 'att-e2e-emp@example.test',
        departmentId,
      });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    employeeHumanId = empBody.employee.employeeId;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'att-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const noDeptCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'No Dept Employee', email: 'att-e2e-nodept@example.test' });
    const noDeptBody = noDeptCreate.body as EmployeeCreateBody;
    noDeptEmployeeId = noDeptBody.employee.id;
    const noDeptLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'att-e2e-nodept@example.test',
        password: noDeptBody.generatedPassword,
      });
    noDeptEmployeeToken = (noDeptLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "punches", "attendances", "leaves", "leave_types", "refresh_tokens", "users", "work_locations", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  describe('Face API ingest', () => {
    let faceApiKey: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/organizations/settings/face-api-key/regenerate')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      faceApiKey = (res.body as { faceApiKey: string }).faceApiKey;
    });

    it('rejects a missing key', async () => {
      await request(app.getHttpServer())
        .post('/attendance/punch/ingest')
        .send({ employeeId: employeeHumanId, organizationId })
        .expect(401);
    });

    it('rejects an incorrect key', async () => {
      await request(app.getHttpServer())
        .post('/attendance/punch/ingest')
        .set('x-face-api-key', 'wrong-key')
        .send({ employeeId: employeeHumanId, organizationId })
        .expect(401);
    });

    it("rejects this org's key used against a different organizationId", async () => {
      // Regression test for the cross-tenant forgery this per-org key
      // model closes off: a key must only authenticate punches for the
      // organization it was generated for.
      await request(app.getHttpServer())
        .post('/attendance/punch/ingest')
        .set('x-face-api-key', faceApiKey)
        .send({
          employeeId: employeeHumanId,
          organizationId: '00000000-0000-0000-0000-000000000000',
        })
        .expect(401);
    });

    it('404s for an unknown employeeId', async () => {
      await request(app.getHttpServer())
        .post('/attendance/punch/ingest')
        .set('x-face-api-key', faceApiKey)
        .send({ employeeId: 'NOPE', organizationId })
        .expect(404);
    });

    it('accepts a correctly-keyed punch and creates/recalculates Attendance', async () => {
      const res = await request(app.getHttpServer())
        .post('/attendance/punch/ingest')
        .set('x-face-api-key', faceApiKey)
        .send({ employeeId: employeeHumanId, organizationId })
        .expect(201);
      const body = res.body as PunchIngestBody;
      expect(body.punch.source).toBe('FACE_API');
      expect(body.attendance.status).toBeDefined();
    });
  });

  describe('Manual punch RBAC + recalculation', () => {
    it('EMPLOYEE gets 403', async () => {
      await request(app.getHttpServer())
        .post('/attendance/punch/manual')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ employeeId })
        .expect(403);
    });

    it('HR can punch on behalf of an employee; two punches spanning >=8h yield PRESENT', async () => {
      const date = offsetDateAvoidingHolidays(-5);
      const inTime = `${date}T09:00:00.000Z`;
      const outTime = `${date}T18:00:00.000Z`;

      await request(app.getHttpServer())
        .post('/attendance/punch/manual')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ employeeId, punchTime: inTime })
        .expect(201);
      const res = await request(app.getHttpServer())
        .post('/attendance/punch/manual')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ employeeId, punchTime: outTime })
        .expect(201);

      const body = res.body as PunchIngestBody;
      expect(body.attendance.status).toBe('PRESENT');

      const row = await prisma.attendance.findFirst({
        where: { employeeId, date },
      });
      expect(row?.isLate).toBe(false);
      expect(row?.workDurationMinutes).toBe(9 * 60);
    });

    it('a single short punch on a weekly-off day resolves to WEEKLY_OFF, not ABSENT', async () => {
      const sunday = nextWeekday(0, 20);
      await request(app.getHttpServer())
        .post('/attendance/punch/manual')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ employeeId, punchTime: `${sunday}T10:00:00.000Z` })
        .expect(201);

      const row = await prisma.attendance.findFirst({
        where: { employeeId, date: sunday },
      });
      expect(row?.status).toBe('WEEKLY_OFF');
    });

    it('regularization JSON on an Attendance row survives a later recalculation', async () => {
      const date = offsetDate(-6);
      await request(app.getHttpServer())
        .post('/attendance/punch/manual')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ employeeId, punchTime: `${date}T09:00:00.000Z` })
        .expect(201);

      const before = await prisma.attendance.findFirstOrThrow({
        where: { employeeId, date },
      });
      await prisma.attendance.update({
        where: { id: before.id },
        data: {
          regularization: {
            requested: true,
            reason: 'Forgot to punch out',
            requestedInTime: null,
            requestedOutTime: `${date}T18:00:00.000Z`,
            status: 'pending',
            reviewedBy: null,
            reviewedAt: null,
            reviewComments: '',
          },
        },
      });

      await request(app.getHttpServer())
        .post('/attendance/punch/manual')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ employeeId, punchTime: `${date}T18:30:00.000Z` })
        .expect(201);

      const after = await prisma.attendance.findFirstOrThrow({
        where: { employeeId, date },
      });
      expect((after.regularization as { status: string }).status).toBe(
        'pending',
      );
      expect((after.regularization as { requested: boolean }).requested).toBe(
        true,
      );
      // Recalculation itself did still run — the punch-derived fields moved.
      expect(after.workDurationMinutes).not.toBe(before.workDurationMinutes);
    });
  });

  describe('recalculateAttendanceForDay direct engine behavior (no-punch branches)', () => {
    let leaveTypeId: string;

    beforeAll(async () => {
      const lt = await scopedPrisma.leaveType.create({
        data: {
          organizationId,
          name: 'Engine Test Leave',
          code: 'ETL',
          allocationType: 'UNLIMITED',
        },
      });
      leaveTypeId = lt.id;
    });

    it('a holiday overrides an approved-leave-derived status when there are no punches', async () => {
      const date = offsetDate(40);
      await scopedPrisma.leave.create({
        data: {
          organizationId,
          employeeId,
          leaveTypeId,
          startDate: date,
          endDate: date,
          totalDays: 1,
          status: 'APPROVED',
        },
      });
      await scopedPrisma.holiday.create({
        data: {
          organizationId,
          name: 'Engine Test Holiday',
          date,
          year: Number(date.slice(0, 4)),
        },
      });

      const row = await attendanceService.recalculateAttendanceForDay(
        scopedPrisma,
        employeeId,
        date,
        organizationId,
      );
      expect(row.status).toBe('HOLIDAY');
    });

    it('weekly-off only overrides a bare ABSENT, never an on_leave-derived status', async () => {
      const sunday = nextWeekday(0, 45);
      await scopedPrisma.leave.create({
        data: {
          organizationId,
          employeeId,
          leaveTypeId,
          startDate: sunday,
          endDate: sunday,
          totalDays: 1,
          status: 'APPROVED',
        },
      });

      const row = await attendanceService.recalculateAttendanceForDay(
        scopedPrisma,
        employeeId,
        sunday,
        organizationId,
      );
      expect(row.status).toBe('ON_LEAVE');
    });

    it('weekly-off overrides a bare ABSENT when there is no leave and no holiday', async () => {
      const sunday = nextWeekday(0, 50);
      const row = await attendanceService.recalculateAttendanceForDay(
        scopedPrisma,
        noDeptEmployeeId,
        sunday,
        organizationId,
      );
      expect(row.status).toBe('WEEKLY_OFF');
    });
  });

  describe('Self-punch geofence enforcement', () => {
    it('rejects a punch outside the assigned geo-fence', async () => {
      await request(app.getHttpServer())
        .post('/attendance/punch/self')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ latitude: FAR_LAT, longitude: FAR_LNG })
        .expect(403);
    });

    it('accepts a punch inside the assigned geo-fence', async () => {
      const res = await request(app.getHttpServer())
        .post('/attendance/punch/self')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ latitude: OFFICE_LAT, longitude: OFFICE_LNG })
        .expect(201);
      expect(
        (res.body as { punchCount: number }).punchCount,
      ).toBeGreaterThanOrEqual(1);
    });

    it('an employee with no department (no geo-fence assigned) punches unchecked', async () => {
      await request(app.getHttpServer())
        .post('/attendance/punch/self')
        .set('Authorization', `Bearer ${noDeptEmployeeToken}`)
        .send({ latitude: FAR_LAT, longitude: FAR_LNG })
        .expect(201);
    });
  });

  describe('GET /attendance/punch/today', () => {
    it("reflects today's punch count for the caller", async () => {
      const res = await request(app.getHttpServer())
        .get('/attendance/punch/today')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      expect(
        (res.body as { punchCount: number }).punchCount,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Work arrangement', () => {
    it('rejects WFH when the organization has it disabled', async () => {
      await prisma.organization.update({
        where: { id: organizationId },
        data: { enableWFH: false },
      });

      await request(app.getHttpServer())
        .put('/attendance/work-arrangement')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ workArrangement: 'WFH' })
        .expect(400);

      await prisma.organization.update({
        where: { id: organizationId },
        data: { enableWFH: true },
      });
    });

    it('accepts a non-WFH arrangement regardless of the org toggle, without touching other fields', async () => {
      const date = offsetDateAvoidingHolidays(-5); // the PRESENT day from the manual-punch test above
      const before = await prisma.attendance.findFirstOrThrow({
        where: { employeeId, date },
      });

      await request(app.getHttpServer())
        .put('/attendance/work-arrangement')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ date, workArrangement: 'HYBRID' })
        .expect(200);

      const after = await prisma.attendance.findFirstOrThrow({
        where: { employeeId, date },
      });
      expect(after.workArrangement).toBe('HYBRID');
      expect(after.status).toBe(before.status);
    });
  });

  describe('Work From Home approval', () => {
    let wfhEmployeeToken: string;
    let wfhEmployeeId: string;
    let sameDeptManagerToken: string;
    let otherDeptManagerToken: string;

    beforeAll(async () => {
      const wfhEmpCreate = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'WFH Employee',
          email: 'att-e2e-wfh-emp@example.test',
          departmentId,
        });
      const wfhEmpBody = wfhEmpCreate.body as EmployeeCreateBody;
      wfhEmployeeId = wfhEmpBody.employee.id;
      const wfhEmpLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'att-e2e-wfh-emp@example.test',
          password: wfhEmpBody.generatedPassword,
        });
      wfhEmployeeToken = (wfhEmpLogin.body as AuthBody).accessToken;

      const sameDeptManagerCreate = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'WFH Same-Dept Manager',
          email: 'att-e2e-wfh-same-mgr@example.test',
          role: 'MANAGER',
          departmentId,
        });
      const sameDeptManagerLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'att-e2e-wfh-same-mgr@example.test',
          password: (sameDeptManagerCreate.body as EmployeeCreateBody)
            .generatedPassword,
        });
      sameDeptManagerToken = (sameDeptManagerLogin.body as AuthBody)
        .accessToken;

      const otherDept = await request(app.getHttpServer())
        .post('/departments')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Sales WFH', code: 'SLW' });
      const otherDeptId = (otherDept.body as { id: string }).id;
      const otherDeptManagerCreate = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'WFH Other-Dept Manager',
          email: 'att-e2e-wfh-other-mgr@example.test',
          role: 'MANAGER',
          departmentId: otherDeptId,
        });
      const otherDeptManagerLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'att-e2e-wfh-other-mgr@example.test',
          password: (otherDeptManagerCreate.body as EmployeeCreateBody)
            .generatedPassword,
        });
      otherDeptManagerToken = (otherDeptManagerLogin.body as AuthBody)
        .accessToken;
    });

    it('requesting WFH starts PENDING, and an unreviewed WFH day still enforces the geo-fence', async () => {
      const date = offsetDate(1);
      const res = await request(app.getHttpServer())
        .put('/attendance/work-arrangement')
        .set('Authorization', `Bearer ${wfhEmployeeToken}`)
        .send({ date, workArrangement: 'WFH' })
        .expect(200);
      expect(
        (res.body as { workArrangementStatus: string }).workArrangementStatus,
      ).toBe('PENDING');

      // Punch resolves to "today" internally, not the requested future
      // date, but PENDING should never bypass the fence regardless.
      await request(app.getHttpServer())
        .post('/attendance/punch/self')
        .set('Authorization', `Bearer ${wfhEmployeeToken}`)
        .send({ latitude: FAR_LAT, longitude: FAR_LNG })
        .expect(403);
    });

    it('EMPLOYEE gets 403 listing or reviewing pending WFH requests', async () => {
      await request(app.getHttpServer())
        .get('/attendance/work-arrangement/pending')
        .set('Authorization', `Bearer ${wfhEmployeeToken}`)
        .expect(403);
    });

    it("HR sees the pending request; a different department's MANAGER cannot review it", async () => {
      const date = offsetDate(1);
      const pending = await request(app.getHttpServer())
        .get('/attendance/work-arrangement/pending')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const row = (
        pending.body as { id: string; date: string; employeeId: string }[]
      ).find((r) => r.date === date && r.employeeId === wfhEmployeeId);
      expect(row).toBeTruthy();

      await request(app.getHttpServer())
        .patch(`/attendance/work-arrangement/${row!.id}/review`)
        .set('Authorization', `Bearer ${otherDeptManagerToken}`)
        .send({ decision: 'APPROVED' })
        .expect(403);
    });

    it("the employee's own department MANAGER approves it, and the fence is then bypassed", async () => {
      const date = offsetDate(1);
      const pending = await request(app.getHttpServer())
        .get('/attendance/work-arrangement/pending')
        .set('Authorization', `Bearer ${sameDeptManagerToken}`)
        .expect(200);
      const row = (pending.body as { id: string; date: string }[]).find(
        (r) => r.date === date,
      );
      expect(row).toBeTruthy();

      // Approving a future-dated request here only proves the review path
      // itself; the actual fence-bypass check below re-requests for today
      // since selfPunch only ever looks at today's row.
      await request(app.getHttpServer())
        .patch(`/attendance/work-arrangement/${row!.id}/review`)
        .set('Authorization', `Bearer ${sameDeptManagerToken}`)
        .send({ decision: 'APPROVED', comments: 'Approved for one day' })
        .expect(200);

      await request(app.getHttpServer())
        .put('/attendance/work-arrangement')
        .set('Authorization', `Bearer ${wfhEmployeeToken}`)
        .send({ workArrangement: 'WFH' })
        .expect(200);
      const todayPending = await request(app.getHttpServer())
        .get('/attendance/work-arrangement/pending')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const todayRow = (
        todayPending.body as { id: string; employeeId: string }[]
      ).find((r) => r.employeeId === wfhEmployeeId);
      await request(app.getHttpServer())
        .patch(`/attendance/work-arrangement/${todayRow!.id}/review`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'APPROVED' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/attendance/punch/self')
        .set('Authorization', `Bearer ${wfhEmployeeToken}`)
        .send({ latitude: FAR_LAT, longitude: FAR_LNG })
        .expect(201);
    });

    it('switching back to OFFICE resets the approval, so the fence applies again', async () => {
      await request(app.getHttpServer())
        .put('/attendance/work-arrangement')
        .set('Authorization', `Bearer ${wfhEmployeeToken}`)
        .send({ workArrangement: 'OFFICE' })
        .expect(200);

      const row = await prisma.attendance.findFirstOrThrow({
        where: { employeeId: wfhEmployeeId, date: offsetDate(0) },
      });
      expect(row.workArrangementStatus).toBe('NONE');

      await request(app.getHttpServer())
        .post('/attendance/punch/self')
        .set('Authorization', `Bearer ${wfhEmployeeToken}`)
        .send({ latitude: FAR_LAT, longitude: FAR_LNG })
        .expect(403);
    });

    it('a rejected WFH request never bypasses the fence', async () => {
      const date = offsetDate(2);
      await request(app.getHttpServer())
        .put('/attendance/work-arrangement')
        .set('Authorization', `Bearer ${wfhEmployeeToken}`)
        .send({ date, workArrangement: 'WFH' })
        .expect(200);

      const pending = await request(app.getHttpServer())
        .get('/attendance/work-arrangement/pending')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const row = (pending.body as { id: string; date: string }[]).find(
        (r) => r.date === date,
      );

      await request(app.getHttpServer())
        .patch(`/attendance/work-arrangement/${row!.id}/review`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'REJECTED', comments: 'Need onsite this week' })
        .expect(200);

      const after = await prisma.attendance.findFirstOrThrow({
        where: { id: row!.id },
      });
      expect(after.workArrangementStatus).toBe('REJECTED');
    });

    it('reviewing an Attendance row with no WFH request is rejected', async () => {
      const date = offsetDate(3);
      await request(app.getHttpServer())
        .put('/attendance/work-arrangement')
        .set('Authorization', `Bearer ${wfhEmployeeToken}`)
        .send({ date, workArrangement: 'HYBRID' })
        .expect(200);
      const row = await prisma.attendance.findFirstOrThrow({
        where: { employeeId: wfhEmployeeId, date },
      });

      await request(app.getHttpServer())
        .patch(`/attendance/work-arrangement/${row.id}/review`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'APPROVED' })
        .expect(400);
    });
  });

  describe('GET /attendance/geofence/mine', () => {
    it("returns the caller's department geo-fence", async () => {
      const res = await request(app.getHttpServer())
        .get('/attendance/geofence/mine')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      expect(
        (res.body as { geoFence: { id: string } | null }).geoFence?.id,
      ).toBe(workLocationId);
    });

    it('returns null for an employee with no assigned geo-fence', async () => {
      const res = await request(app.getHttpServer())
        .get('/attendance/geofence/mine')
        .set('Authorization', `Bearer ${noDeptEmployeeToken}`)
        .expect(200);
      expect((res.body as { geoFence: null }).geoFence).toBeNull();
    });
  });

  describe('GET /attendance role-scoped listing', () => {
    it('EMPLOYEE only sees their own records, even when passing another employeeId', async () => {
      const res = await request(app.getHttpServer())
        .get('/attendance')
        .query({ employeeId: noDeptEmployeeId })
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      const records = (res.body as { data: { employeeId: string }[] }).data;
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((r) => r.employeeId === employeeId)).toBe(true);
    });

    it('ADMIN sees records across employees', async () => {
      const res = await request(app.getHttpServer())
        .get('/attendance')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const records = (res.body as { data: { employeeId: string }[] }).data;
      const employeeIds = new Set(records.map((r) => r.employeeId));
      expect(employeeIds.has(employeeId)).toBe(true);
      expect(employeeIds.has(noDeptEmployeeId)).toBe(true);
    });

    it('a low ?limit= caps the number of records returned', async () => {
      const res = await request(app.getHttpServer())
        .get('/attendance')
        .query({ limit: 1 })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const records = (res.body as { data: unknown[] }).data;
      expect(records.length).toBeLessThanOrEqual(1);
    });

    it('rejects a ?limit= above the 2000 hard cap', async () => {
      await request(app.getHttpServer())
        .get('/attendance')
        .query({ limit: 2001 })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });
  });

  describe('Regularization', () => {
    it('rejects a future-dated request', async () => {
      await request(app.getHttpServer())
        .post('/attendance/regularization')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ date: offsetDate(1), reason: 'Forgot to punch' })
        .expect(400);
    });

    it('EMPLOYEE gets 403 reviewing a regularization request', async () => {
      const date = offsetDate(-20);
      const res = await request(app.getHttpServer())
        .post('/attendance/regularization')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          date,
          requestedInTime: `${date}T09:00:00.000Z`,
          requestedOutTime: `${date}T18:00:00.000Z`,
          reason: 'Forgot to punch',
        })
        .expect(201);
      const attendanceId = (res.body as { id: string }).id;

      await request(app.getHttpServer())
        .patch(`/attendance/regularization/${attendanceId}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ decision: 'APPROVED' })
        .expect(403);
    });

    it('a request with no prior Attendance row creates one (ABSENT/SYSTEM) with the regularization pending', async () => {
      const date = offsetDate(-21);
      const res = await request(app.getHttpServer())
        .post('/attendance/regularization')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          date,
          requestedInTime: `${date}T09:00:00.000Z`,
          requestedOutTime: `${date}T18:00:00.000Z`,
          reason: 'Forgot to punch',
        })
        .expect(201);
      const body = res.body as {
        status: string;
        source: string;
        regularization: { requested: boolean; status: string };
      };
      expect(body.status).toBe('ABSENT');
      expect(body.source).toBe('SYSTEM');
      expect(body.regularization.requested).toBe(true);
      expect(body.regularization.status).toBe('pending');
    });

    it('HR approves; inTime/outTime are hard-set, status forced PRESENT, source REGULARIZED', async () => {
      const date = offsetDate(-22);
      const req = await request(app.getHttpServer())
        .post('/attendance/regularization')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          date,
          requestedInTime: `${date}T09:00:00.000Z`,
          requestedOutTime: `${date}T18:00:00.000Z`,
          reason: 'Forgot to punch',
        })
        .expect(201);
      const attendanceId = (req.body as { id: string }).id;

      const res = await request(app.getHttpServer())
        .patch(`/attendance/regularization/${attendanceId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'APPROVED', comments: 'Looks right' })
        .expect(200);
      const body = res.body as {
        status: string;
        source: string;
        workDurationMinutes: number;
        regularization: { status: string; reviewComments: string };
      };
      expect(body.status).toBe('PRESENT');
      expect(body.source).toBe('REGULARIZED');
      expect(body.workDurationMinutes).toBe(9 * 60);
      expect(body.regularization.status).toBe('approved');
      expect(body.regularization.reviewComments).toBe('Looks right');
    });

    it('rejecting leaves inTime/outTime/status/source untouched, only the regularization sub-fields change', async () => {
      const date = offsetDate(-23);
      const req = await request(app.getHttpServer())
        .post('/attendance/regularization')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          date,
          requestedInTime: `${date}T09:00:00.000Z`,
          requestedOutTime: `${date}T18:00:00.000Z`,
          reason: 'Forgot to punch',
        })
        .expect(201);
      const attendanceId = (req.body as { id: string }).id;
      const before = req.body as { status: string; source: string };

      const res = await request(app.getHttpServer())
        .patch(`/attendance/regularization/${attendanceId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'REJECTED', comments: 'No evidence' })
        .expect(200);
      const body = res.body as {
        status: string;
        source: string;
        inTime: string | null;
        regularization: { status: string; reviewComments: string };
      };
      expect(body.status).toBe(before.status);
      expect(body.source).toBe(before.source);
      expect(body.inTime).toBeNull();
      expect(body.regularization.status).toBe('rejected');
      expect(body.regularization.reviewComments).toBe('No evidence');
    });
  });

  describe('Bulk import', () => {
    let managerToken: string;
    let importEmployeeHumanId: string;
    let managerBatchId: string;

    beforeAll(async () => {
      const managerCreate = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Import Manager',
          email: 'att-e2e-import-manager@example.test',
          role: 'MANAGER',
          departmentId,
        });
      const managerLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'att-e2e-import-manager@example.test',
          password: (managerCreate.body as EmployeeCreateBody)
            .generatedPassword,
        });
      managerToken = (managerLogin.body as AuthBody).accessToken;

      const importEmpCreate = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Import Target',
          email: 'att-e2e-import-target@example.test',
          departmentId,
        });
      importEmployeeHumanId = (importEmpCreate.body as EmployeeCreateBody)
        .employee.employeeId;
    });

    it('EMPLOYEE gets 403 uploading a batch', async () => {
      await request(app.getHttpServer())
        .post('/attendance/import')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          rows: [{ employeeId: importEmployeeHumanId, date: offsetDate(-30) }],
        })
        .expect(403);
    });

    it('MANAGER uploads a batch with one valid and one invalid row', async () => {
      const res = await request(app.getHttpServer())
        .post('/attendance/import')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          rows: [
            {
              employeeId: importEmployeeHumanId,
              date: offsetDate(-30),
              inTime: `${offsetDate(-30)}T09:00:00.000Z`,
              outTime: `${offsetDate(-30)}T18:00:00.000Z`,
            },
            { employeeId: 'UNKNOWN-CODE', date: offsetDate(-31) },
          ],
        })
        .expect(201);
      managerBatchId = (res.body as { id: string; status: string }).id;
      expect((res.body as { status: string }).status).toBe(
        'PENDING_VALIDATION',
      );
    });

    it('GET /import: MANAGER sees only their own uploads, HR sees all', async () => {
      const managerList = await request(app.getHttpServer())
        .get('/attendance/import')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(
        (managerList.body as { id: string }[]).every(
          (b) => b.id === managerBatchId,
        ),
      ).toBe(true);

      const hrList = await request(app.getHttpServer())
        .get('/attendance/import')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect(
        (hrList.body as { id: string }[]).some((b) => b.id === managerBatchId),
      ).toBe(true);
    });

    it('validate reports the unknown-employee row error and stays PENDING_VALIDATION', async () => {
      const res = await request(app.getHttpServer())
        .post(`/attendance/import/${managerBatchId}/validate`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(201);
      const body = res.body as {
        status: string;
        validationErrors: { row: number; error: string }[];
      };
      expect(body.status).toBe('PENDING_VALIDATION');
      expect(body.validationErrors).toHaveLength(1);
    });

    it('execute is rejected while the batch is not VALIDATED', async () => {
      await request(app.getHttpServer())
        .post(`/attendance/import/${managerBatchId}/execute`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(400);
    });

    it('a clean batch validates to VALIDATED and executes with the biometric-skip rule honored', async () => {
      // A separate, all-valid batch: one fresh row (imports) and one row
      // that collides with an existing FACE_API-sourced punch (skipped).
      const freshDate = offsetDate(-32);
      const biometricDate = offsetDate(-33);

      await scopedPrisma.attendance.create({
        data: {
          organizationId,
          employeeId,
          date: biometricDate,
          status: 'PRESENT',
          source: 'FACE_API',
          inTime: new Date(`${biometricDate}T09:00:00.000Z`),
        },
      });

      const upload = await request(app.getHttpServer())
        .post('/attendance/import')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          rows: [
            {
              employeeId: importEmployeeHumanId,
              date: freshDate,
              inTime: `${freshDate}T09:00:00.000Z`,
              outTime: `${freshDate}T18:00:00.000Z`,
            },
            {
              employeeId: employeeHumanId,
              date: biometricDate,
              inTime: `${biometricDate}T10:00:00.000Z`,
              outTime: `${biometricDate}T19:00:00.000Z`,
            },
          ],
        })
        .expect(201);
      const cleanBatchId = (upload.body as { id: string }).id;

      const validated = await request(app.getHttpServer())
        .post(`/attendance/import/${cleanBatchId}/validate`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(201);
      expect((validated.body as { status: string }).status).toBe('VALIDATED');

      const executed = await request(app.getHttpServer())
        .post(`/attendance/import/${cleanBatchId}/execute`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(201);
      const execBody = executed.body as {
        status: string;
        executionResult: { imported: number; skipped: number; errors: number };
      };
      expect(execBody.status).toBe('EXECUTED');
      expect(execBody.executionResult).toEqual({
        imported: 1,
        skipped: 1,
        errors: 0,
      });

      const freshRow = await prisma.attendance.findFirst({
        where: {
          organizationId,
          date: freshDate,
          employee: { employeeId: importEmployeeHumanId },
        },
      });
      expect(freshRow?.status).toBe('PRESENT');
      expect(freshRow?.source).toBe('EXCEL_IMPORT');

      const biometricRow = await prisma.attendance.findFirst({
        where: { organizationId, employeeId, date: biometricDate },
      });
      // Untouched by the import — still the original biometric punch.
      expect(biometricRow?.source).toBe('FACE_API');
      expect(biometricRow?.inTime?.toISOString()).toBe(
        `${biometricDate}T09:00:00.000Z`,
      );
    });

    it('reject sets status REJECTED', async () => {
      const upload = await request(app.getHttpServer())
        .post('/attendance/import')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          rows: [{ employeeId: importEmployeeHumanId, date: offsetDate(-34) }],
        })
        .expect(201);
      const batchId = (upload.body as { id: string }).id;

      const rejected = await request(app.getHttpServer())
        .post(`/attendance/import/${batchId}/reject`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(201);
      expect((rejected.body as { status: string }).status).toBe('REJECTED');
    });
  });

  describe('Notify absentees', () => {
    it('reports employees who resolve to ABSENT for the given date', async () => {
      // A weekday, well in the past, so it can't collide with the
      // no-department fallback's Sat/Sun weekly-off (which would resolve
      // to WEEKLY_OFF instead of ABSENT).
      const date = nextWeekday(3, -60);
      const res = await request(app.getHttpServer())
        .post('/attendance/notify-absentees')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ date })
        .expect(201);
      const body = res.body as {
        date: string;
        notifiedCount: number;
        employeeIds: string[];
      };
      expect(body.date).toBe(date);
      expect(body.employeeIds).toContain(noDeptEmployeeId);
      expect(body.notifiedCount).toBe(body.employeeIds.length);
    });

    it('EMPLOYEE gets 403', async () => {
      await request(app.getHttpServer())
        .post('/attendance/notify-absentees')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(403);
    });
  });
});
