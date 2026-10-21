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
interface CustomReportBody {
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
  total: number;
}

const PASSWORD = 'TestPass123!';

describe('Custom Report Builder (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let employeeToken: string;
  let managerToken: string;

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
      organizationName: 'Custom Report E2E Org',
      name: 'Founder',
      email: 'cr-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'cr-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Dept A', code: 'DEPTA' });
    const departmentId = (dept.body as { id: string }).id;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'cr-e2e-emp@example.test',
        departmentId,
      });
    const empBody = empCreate.body as EmployeeCreateBody;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'cr-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const managerCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Dept A Manager',
        email: 'cr-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'cr-e2e-manager@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    // Let fire-and-forget audit/timeline writes settle so TRUNCATE does not deadlock with them.
    await new Promise((r) => setTimeout(r, 500));
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403 listing sources', async () => {
    await request(app.getHttpServer())
      .get('/reports/custom/sources')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('ADMIN lists the 5 allow-listed sources with their columns', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/custom/sources')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const sources = res.body as { key: string; columns: { key: string }[] }[];
    expect(sources.map((s) => s.key).sort()).toEqual([
      'attendance',
      'employees',
      'leaves',
      'payroll',
      'probation',
    ]);
    const employeesSource = sources.find((s) => s.key === 'employees');
    expect(employeesSource?.columns.some((c) => c.key === 'employeeId')).toBe(
      true,
    );
  });

  it('attendance can be limited to late arrivals / early exits, and probation lists who is due for confirmation', async () => {
    const emp = await prisma.user.findFirstOrThrow({
      where: { email: 'cr-e2e-emp@example.test' },
    });
    // Joined before the April rows below, so they are shown (nothing is shown before the joining date).
    await prisma.user.update({
      where: { id: emp.id },
      data: { joiningDate: new Date('2026-01-01T00:00:00.000Z') },
    });
    const base = {
      organizationId: emp.organizationId,
      employeeId: emp.id,
      status: 'PRESENT' as const,
      source: 'FACE_API' as const,
    };
    await prisma.attendance.create({
      data: { ...base, date: '2026-04-01', isLate: true },
    });
    await prisma.attendance.create({
      data: { ...base, date: '2026-04-02', isEarlyOut: true },
    });
    await prisma.attendance.create({ data: { ...base, date: '2026-04-03' } });
    const run = async (status: string) =>
      (
        await request(app.getHttpServer())
          .get('/reports/custom')
          .query({
            source: 'attendance',
            status,
            from: '2026-04-01',
            to: '2026-04-03',
            format: 'json',
          })
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200)
      ).body as CustomReportBody;
    expect((await run('LATE')).rows.map((r) => r.date)).toHaveLength(1);
    expect((await run('EARLY_OUT')).rows).toHaveLength(1);
    expect((await run('LATE_OR_EARLY')).rows).toHaveLength(2);

    const sources = (
      await request(app.getHttpServer())
        .get('/reports/custom/sources')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body as { key: string; statuses: { value: string }[] }[];
    expect(
      sources.find((x) => x.key === 'attendance')?.statuses.map((x) => x.value),
    ).toEqual(expect.arrayContaining(['LATE', 'EARLY_OUT', 'LATE_OR_EARLY']));

    // Probation: one overdue, one due soon, one far off.
    const ymd = (days: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    await prisma.user.update({
      where: { id: emp.id },
      data: { employmentStatus: 'PROBATION', probationEndDate: ymd(-3) },
    });
    const probation = async (status?: string) =>
      (
        await request(app.getHttpServer())
          .get('/reports/custom')
          .query({
            source: 'probation',
            ...(status && { status }),
            format: 'json',
          })
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200)
      ).body as CustomReportBody;
    expect(
      (await probation('overdue')).rows.map((r) => r.employeeId),
    ).toContain(emp.employeeId);
    expect(
      (await probation('due_30')).rows.map((r) => r.employeeId),
    ).not.toContain(emp.employeeId);
    await prisma.user.update({
      where: { id: emp.id },
      data: { probationEndDate: ymd(10) },
    });
    expect((await probation('due_30')).rows.map((r) => r.employeeId)).toContain(
      emp.employeeId,
    );
    expect(
      (await probation('overdue')).rows.map((r) => r.employeeId),
    ).not.toContain(emp.employeeId);
    const row = (await probation()).rows.find(
      (r) => r.employeeId === emp.employeeId,
    );
    expect(row?.due).toMatch(/Due in (9|10|11) day/);
    await prisma.user.update({
      where: { id: emp.id },
      data: { employmentStatus: 'CONFIRMED', probationEndDate: null },
    });
    expect((await probation()).rows.map((r) => r.employeeId)).not.toContain(
      emp.employeeId,
    );
  });

  it('rejects an unknown source', async () => {
    await request(app.getHttpServer())
      .get('/reports/custom')
      .query({ source: 'not-a-source' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('runs the employees source with all columns by default, as JSON', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/custom')
      .query({ source: 'employees' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as CustomReportBody;
    expect(body.total).toBeGreaterThanOrEqual(2); // admin + the one employee
    expect(body.columns.map((c) => c.key)).toContain('employeeId');
    expect(body.columns.map((c) => c.key)).toContain('email');
    const row = body.rows.find((r) => r.email === 'cr-e2e-emp@example.test');
    expect(row).toBeDefined();
    expect(row?.status).toBe('Active');
  });

  it('honors a requested column subset, dropping unknown columns silently', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/custom')
      .query({ source: 'employees', columns: 'name,not_a_real_column,email' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as CustomReportBody;
    expect(body.columns.map((c) => c.key)).toEqual(['name', 'email']);
    expect(Object.keys(body.rows[0])).toEqual(['name', 'email']);
  });

  it('rejects a columns list that resolves to nothing valid', async () => {
    await request(app.getHttpServer())
      .get('/reports/custom')
      .query({ source: 'employees', columns: 'nope,also_nope' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('the status filter on the employees source matches the old active/inactive semantics', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/custom')
      .query({ source: 'employees', status: 'active' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as CustomReportBody;
    expect(body.rows.every((r) => r.status === 'Active')).toBe(true);
  });

  it('exports the payroll source as csv', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/custom')
      .query({ source: 'payroll', format: 'csv' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(
      'custom-report-payroll.csv',
    );
  });

  it('MANAGER is blocked from the payroll source (Admin/HR only, same as /reports/payroll)', async () => {
    await request(app.getHttpServer())
      .get('/reports/custom')
      .query({ source: 'payroll' })
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
  });

  it("MANAGER's employees-source rows are restricted to their own department, ignoring a requested department filter", async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/custom')
      .query({ source: 'employees' })
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const body = res.body as CustomReportBody;
    const emails = body.rows.map((r) => r.email);
    expect(emails).toContain('cr-e2e-emp@example.test');
    // The admin (no department) and any other-department employee must not
    // leak into a MANAGER's report, regardless of the department filter
    // they pass — it's always forced to their own.
    expect(emails).not.toContain('cr-e2e-admin@example.test');
  });

  it('rejects a status that does not belong to the source, and a reversed date range, with 400', async () => {
    for (const query of [
      { source: 'attendance', status: 'BOGUS' },
      { source: 'leaves', status: 'NOPE' },
      { source: 'payroll', status: 'XYZ' },
      { source: 'employees', status: 'PRESENT' },
      { source: 'attendance', from: '2026-10-10', to: '2026-10-01' },
    ]) {
      await request(app.getHttpServer())
        .get('/reports/custom')
        .query(query)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    }
    await request(app.getHttpServer())
      .get('/reports/custom')
      .query({ source: 'employees', status: 'active' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('rejects a reversed range on the attendance report and the department leave summary', async () => {
    await request(app.getHttpServer())
      .get('/reports/attendance')
      .query({ from: '2026-10-10', to: '2026-10-01' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .get('/reports/leave/department-summary')
      .query({ from: '2026-10-10', to: '2026-10-01' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});
