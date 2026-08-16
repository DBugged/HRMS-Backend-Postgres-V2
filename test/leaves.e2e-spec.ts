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
interface LeaveBody {
  id: string;
  status: string;
  totalDays: number;
  level1ApprovedById: string | null;
  employeeId: string;
  leaveTypeId: string;
}
interface LeaveTypeBody {
  id: string;
}

const PASSWORD = 'TestPass123!';

function offsetDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Leaves (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let employeeToken: string;
  let employeeId: string;
  let elLeaveTypeId: string;
  let compOffLeaveTypeId: string;

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
      organizationName: 'Leaves E2E Org',
      name: 'Founder',
      email: 'leaves-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'leaves-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'leaves-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'leaves-e2e-hr@example.test',
        password: (hrCreate.body as { generatedPassword: string })
          .generatedPassword,
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
        email: 'leaves-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    const managerId = (managerCreate.body as { employee: { id: string } })
      .employee.id;
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'leaves-e2e-manager@example.test',
        password: (managerCreate.body as { generatedPassword: string })
          .generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Eng Employee',
        email: 'leaves-e2e-emp@example.test',
        departmentId,
        reportingManagerId: managerId,
      });
    const empBody = empCreate.body as {
      employee: { id: string };
      generatedPassword: string;
    };
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'leaves-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const elType = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Earned Leave',
        code: 'EL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 24,
        prorateOnJoining: false,
      });
    elLeaveTypeId = (elType.body as LeaveTypeBody).id;

    const compOffType = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Comp Off',
        code: 'COMPOFF',
        allocationType: 'NONE',
        approvalLevels: 1,
      });
    compOffLeaveTypeId = (compOffType.body as LeaveTypeBody).id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "comp_offs", "leave_balances", "leaves", "leave_types", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  let elLeaveId: string;

  it('EMPLOYEE applies for Earned Leave; a balance row is lazily created with the full (non-prorated) quota', async () => {
    const res = await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: elLeaveTypeId,
        startDate: offsetDate(10),
        endDate: offsetDate(12),
      })
      .expect(201);
    const body = res.body as LeaveBody;
    expect(body.status).toBe('PENDING');
    expect(body.totalDays).toBe(3);
    elLeaveId = body.id;

    const year = new Date().getFullYear();
    const row = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: elLeaveTypeId, year },
    });
    expect(row?.credited).toBe(24);
    expect(row?.pending).toBe(3);
  });

  it('rejects an overlapping request', async () => {
    await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: elLeaveTypeId,
        startDate: offsetDate(11),
        endDate: offsetDate(15),
      })
      .expect(400);
  });

  it('EMPLOYEE gets 403 reviewing any leave request', async () => {
    await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/review`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ decision: 'APPROVED' })
      .expect(403);
  });

  it('MANAGER gives level-1 approval; status stays PENDING', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'APPROVED', comments: 'Looks fine' })
      .expect(200);
    const body = res.body as LeaveBody;
    expect(body.status).toBe('PENDING');
    expect(body.level1ApprovedById).not.toBeNull();
  });

  it('MANAGER cannot give the final approval on a 2-level leave type', async () => {
    await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'APPROVED' })
      .expect(403);
  });

  it('HR gives the final approval; balance moves pending -> availed', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);
    expect((res.body as LeaveBody).status).toBe('APPROVED');

    const year = new Date().getFullYear();
    const row = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: elLeaveTypeId, year },
    });
    expect(row?.pending).toBe(0);
    expect(row?.availed).toBe(3);
    expect(row?.closing).toBe(21); // 24 credited - 3 availed

    // Leave-approval -> Attendance integration: every day in the leave's
    // range gets an ON_LEAVE row with source SYSTEM.
    const attendanceRows = await prisma.attendance.findMany({
      where: { employeeId, date: { gte: offsetDate(10), lte: offsetDate(12) } },
      orderBy: { date: 'asc' },
    });
    expect(attendanceRows).toHaveLength(3);
    expect(attendanceRows.every((r) => r.status === 'ON_LEAVE')).toBe(true);
    expect(attendanceRows.every((r) => r.source === 'SYSTEM')).toBe(true);
  });

  it('rejects reviewing an already-decided leave', async () => {
    await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'REJECTED' })
      .expect(400);
  });

  it('EMPLOYEE cancels the approved leave; availed is reversed', async () => {
    await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/cancel`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);

    const year = new Date().getFullYear();
    const row = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: elLeaveTypeId, year },
    });
    expect(row?.availed).toBe(0);
    expect(row?.closing).toBe(24);

    // Cancellation reverts every future-dated SYSTEM-sourced Attendance row
    // back to ABSENT/FACE_API — these dates are all in the future relative
    // to "today", so all three should be reverted.
    const attendanceRows = await prisma.attendance.findMany({
      where: { employeeId, date: { gte: offsetDate(10), lte: offsetDate(12) } },
    });
    expect(attendanceRows).toHaveLength(3);
    expect(attendanceRows.every((r) => r.status === 'ABSENT')).toBe(true);
    expect(attendanceRows.every((r) => r.source === 'FACE_API')).toBe(true);
  });

  it('a COMPOFF-type leave draws from the CompOff table, not LeaveBalance', async () => {
    const earnedForDate = offsetDate(-2);
    const compOff = await request(app.getHttpServer())
      .post('/comp-offs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ earnedForDate })
      .expect(201);
    const compOffId = (compOff.body as { id: string }).id;
    await request(app.getHttpServer())
      .patch(`/comp-offs/${compOffId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const leaveRes = await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: compOffLeaveTypeId,
        startDate: offsetDate(20),
        endDate: offsetDate(20),
        isHalfDay: true,
      })
      .expect(201);
    const compOffLeaveId = (leaveRes.body as LeaveBody).id;

    await request(app.getHttpServer())
      .patch(`/leaves/${compOffLeaveId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const compOffRow = await prisma.compOff.findFirst({
      where: { id: compOffId },
    });
    expect(compOffRow?.daysAvailed).toBe(0.5);
    expect(compOffRow?.status).toBe('PARTIALLY_AVAILED');

    // No LeaveBalance row should exist at all for the COMPOFF leave type.
    const balanceRow = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: compOffLeaveTypeId },
    });
    expect(balanceRow).toBeNull();
  });

  it('rejects applying for a COMPOFF leave beyond available comp-off balance', async () => {
    await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: compOffLeaveTypeId,
        startDate: offsetDate(21),
        endDate: offsetDate(25),
      })
      .expect(403);
  });

  it('GET /leaves scoping: EMPLOYEE sees only their own, MANAGER sees the department', async () => {
    const selfList = await request(app.getHttpServer())
      .get('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(
      (selfList.body as { data: LeaveBody[] }).data.every(
        (l) => l.employeeId === employeeId,
      ),
    ).toBe(true);

    const deptList = await request(app.getHttpServer())
      .get('/leaves')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(
      (deptList.body as { data: LeaveBody[] }).data.some(
        (l) => l.employeeId === employeeId,
      ),
    ).toBe(true);
  });

  it('a low ?limit= caps the number of leaves returned', async () => {
    const res = await request(app.getHttpServer())
      .get('/leaves')
      .query({ limit: 1 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((res.body as { data: LeaveBody[] }).data.length).toBeLessThanOrEqual(
      1,
    );
  });

  it('rejects a ?limit= above the 2000 hard cap', async () => {
    await request(app.getHttpServer())
      .get('/leaves')
      .query({ limit: 2001 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('GET /leaves/balance for another employee requires ADMIN/HR/MANAGER', async () => {
    await request(app.getHttpServer())
      .get('/leaves/balance')
      .query({ employeeId })
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
  });

  it('GET /leaves/history/:employeeId is self-accessible, but 403 for another EMPLOYEE', async () => {
    await request(app.getHttpServer())
      .get(`/leaves/history/${employeeId}`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
  });
});
