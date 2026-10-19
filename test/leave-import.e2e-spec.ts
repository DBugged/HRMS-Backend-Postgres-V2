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
  employee: { id: string; employeeId: string };
  generatedPassword: string;
}
interface RowResult {
  row: number;
  status: 'OK' | 'IMPORTED' | 'ERROR';
  message?: string;
  totalDays?: number;
}
interface ImportResult {
  dryRun: boolean;
  total: number;
  ok: number;
  imported: number;
  failed: number;
  rows: RowResult[];
}
interface GridResponse {
  cells: Record<string, Record<number, string>>;
}

const PASSWORD = 'TestPass123!';

describe('Leave import (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
  let organizationId: string;
  let empId: string;
  let empCode: string;
  let adminCode: string;
  let leaveTypeId: string;

  const send = (token: string, rows: object[], dryRun?: boolean) =>
    request(app.getHttpServer())
      .post('/leaves/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows, ...(dryRun !== undefined && { dryRun }) });

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
      organizationName: 'Leave Import Org',
      name: 'Founder',
      email: 'li-e2e-admin@example.test',
      password: PASSWORD,
    });
    adminToken = (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'li-e2e-admin@example.test', password: PASSWORD })
      ).body as AuthBody
    ).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'li-e2e-admin@example.test' },
    });
    organizationId = admin.organizationId;
    adminCode = admin.employeeId;
    await prisma.user.update({
      where: { id: admin.id },
      data: { joiningDate: new Date('2020-01-01T00:00:00.000Z') },
    });

    const mk = async (name: string, email: string, role?: string) => {
      const created = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name,
          email,
          joiningDate: '2020-01-01',
          ...(role && { role }),
        });
      const body = created.body as EmployeeCreateBody;
      const token = (
        (
          await request(app.getHttpServer())
            .post('/auth/login')
            .send({ email, password: body.generatedPassword })
        ).body as AuthBody
      ).accessToken;
      return { token, id: body.employee.id, code: body.employee.employeeId };
    };
    const emp = await mk('Migrated Employee', 'li-e2e-emp@example.test');
    employeeToken = emp.token;
    empId = emp.id;
    empCode = emp.code;
    hrToken = (await mk('HR Person', 'li-e2e-hr@example.test', 'HR')).token;

    const lt = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Imported Leave',
        code: 'IMPL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 5,
        prorateOnJoining: false,
      });
    leaveTypeId = (lt.body as { id: string }).id;

    // The state a migration leaves behind: empty Absent rows (an Excel import with no times) for the days that were leave.
    for (const date of ['2026-08-10', '2026-08-11', '2026-08-12']) {
      await prisma.attendance.create({
        data: {
          organizationId,
          employeeId: empId,
          date,
          status: 'ABSENT',
          source: 'EXCEL_IMPORT',
        },
      });
    }
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 500));
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('only Admin and HR can import', async () => {
    await send(employeeToken, [
      {
        employeeId: empCode,
        leaveType: 'IMPL',
        startDate: '2026-08-10',
        endDate: '2026-08-10',
      },
    ]).expect(403);
  });

  it('a check run reports each row and saves nothing', async () => {
    const res = await send(
      adminToken,
      [
        {
          employeeId: empCode,
          leaveType: 'IMPL',
          startDate: '2026-08-10',
          endDate: '2026-08-12',
          reason: 'Fever',
        }, // ok: 3 working days
        {
          employeeId: 'NOPE-1',
          leaveType: 'IMPL',
          startDate: '2026-08-10',
          endDate: '2026-08-10',
        },
        {
          employeeId: empCode,
          leaveType: 'No Such Type',
          startDate: '2026-08-10',
          endDate: '2026-08-10',
        },
        {
          employeeId: empCode,
          leaveType: 'IMPL',
          startDate: '2026-02-30',
          endDate: '2026-03-01',
        },
        {
          employeeId: empCode,
          leaveType: 'IMPL',
          startDate: '2019-12-30',
          endDate: '2019-12-30',
        }, // before joining
        {
          employeeId: empCode,
          leaveType: 'IMPL',
          startDate: '2026-08-17',
          endDate: '2026-08-18',
          halfDay: 'yes',
        },
        {
          employeeId: empCode,
          leaveType: 'IMPL',
          startDate: '2026-08-11',
          endDate: '2026-08-11',
        }, // overlaps the first row of the file
        {
          employeeId: empCode,
          leaveType: 'IMPL',
          startDate: '2026-09-01',
          endDate: '2026-09-04',
        }, // 4 days, only 2 left after row 1
      ],
      true,
    ).expect(201);
    const body = res.body as ImportResult;
    expect(body.dryRun).toBe(true);
    const status = body.rows.map((r) => r.status);
    expect(status).toEqual([
      'OK',
      'ERROR',
      'ERROR',
      'ERROR',
      'ERROR',
      'ERROR',
      'ERROR',
      'ERROR',
    ]);
    expect(body.rows[0].totalDays).toBe(3);
    expect(body.rows[1].message).toMatch(/Unknown employee/);
    expect(body.rows[2].message).toMatch(/Unknown leave type/);
    expect(body.rows[3].message).toMatch(/real dates/);
    expect(body.rows[4].message).toMatch(/joining date/);
    expect(body.rows[5].message).toMatch(/half day/i);
    expect(body.rows[6].message).toMatch(/overlap/i);
    expect(body.rows[7].message).toMatch(/Not enough/);
    expect(await prisma.leave.count({ where: { organizationId } })).toBe(0);
    const abs = await prisma.attendance.findMany({
      where: {
        employeeId: empId,
        date: { in: ['2026-08-10', '2026-08-11', '2026-08-12'] },
      },
    });
    expect(abs.every((a) => a.status === 'ABSENT')).toBe(true);
  });

  it('importing records approved leave, deducts the balance, turns the Absent days into On Leave on the tracker, and tells nobody', async () => {
    const notificationsBefore = await prisma.notification.count({
      where: { organizationId },
    });
    const res = await send(
      adminToken,
      [
        {
          employeeId: empCode,
          leaveType: 'Imported Leave',
          startDate: '2026-08-10',
          endDate: '2026-08-12',
          reason: 'Fever',
        },
      ],
      false,
    ).expect(201);
    const body = res.body as ImportResult;
    expect(body).toMatchObject({ dryRun: false, imported: 1, failed: 0 });
    expect(body.rows[0].totalDays).toBe(3);

    const leave = await prisma.leave.findFirstOrThrow({
      where: { employeeId: empId },
    });
    expect(leave).toMatchObject({ status: 'APPROVED', totalDays: 3 });
    expect(leave.remarks).toMatch(/Imported leave: Fever/);
    const balance = await prisma.leaveBalance.findFirstOrThrow({
      where: { employeeId: empId, leaveTypeId },
    });
    expect(balance.availed).toBe(3);
    expect(balance.pending).toBe(0);

    // The attendance tracker shows it: the migrated Absent days are now On Leave.
    const grid = (
      await request(app.getHttpServer())
        .get('/leave-tracker/grid')
        .query({ month: 8, year: 2026 })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body as GridResponse;
    expect([10, 11, 12].map((d) => grid.cells[empId]?.[d])).toEqual([
      'ON_LEAVE',
      'ON_LEAVE',
      'ON_LEAVE',
    ]);

    // No in-app notification went to the employee, a manager or HR.
    expect(await prisma.notification.count({ where: { organizationId } })).toBe(
      notificationsBefore,
    );
  });

  it('running the same file again is refused row by row (no double deduction)', async () => {
    const res = await send(
      adminToken,
      [
        {
          employeeId: empCode,
          leaveType: 'IMPL',
          startDate: '2026-08-10',
          endDate: '2026-08-12',
        },
      ],
      false,
    ).expect(201);
    expect((res.body as ImportResult).rows[0]).toMatchObject({
      status: 'ERROR',
    });
    expect((res.body as ImportResult).rows[0].message).toMatch(/overlap/i);
    expect(
      (
        await prisma.leaveBalance.findFirstOrThrow({
          where: { employeeId: empId, leaveTypeId },
        })
      ).availed,
    ).toBe(3);
  });

  it('refuses a month whose payroll is locked, and HR cannot import for an Admin', async () => {
    await prisma.payrollRun.create({
      data: {
        organizationId,
        employeeId: empId,
        month: 7,
        year: 2026,
        status: 'LOCKED',
      },
    });
    const locked = await send(
      adminToken,
      [
        {
          employeeId: empCode,
          leaveType: 'IMPL',
          startDate: '2026-07-06',
          endDate: '2026-07-06',
        },
      ],
      true,
    ).expect(201);
    expect((locked.body as ImportResult).rows[0].message).toMatch(
      /payroll period/,
    );

    const hr = await send(
      hrToken,
      [
        {
          employeeId: adminCode,
          leaveType: 'IMPL',
          startDate: '2026-08-17',
          endDate: '2026-08-17',
        },
      ],
      true,
    ).expect(201);
    expect((hr.body as ImportResult).rows[0].message).toMatch(/Only an Admin/);
  });
});
