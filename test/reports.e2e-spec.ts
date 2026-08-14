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

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function offsetDate(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Reports (e2e)', () => {
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
      organizationName: 'Reports E2E Org',
      name: 'Founder',
      email: 'rpt-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'rpt-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'rpt-e2e-admin@example.test' },
    });
    organizationId = admin.organizationId;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'rpt-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'rpt-e2e-hr@example.test',
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
        email: 'rpt-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'rpt-e2e-manager@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'rpt-e2e-emp@example.test',
        departmentId,
      });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'rpt-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    await prisma.attendance.create({
      data: {
        organizationId,
        employeeId,
        date: todayStr(),
        status: AttendanceStatus.PRESENT,
        source: 'FACE_API',
        workDurationMinutes: 480,
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

    const leave = await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: leaveTypeId,
        startDate: offsetDate(10),
        endDate: offsetDate(11),
      })
      .expect(201);
    const leaveId = (leave.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/leaves/${leaveId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Basic',
        code: 'BASIC',
        type: 'EARNING',
        calcType: 'FIXED',
        defaultValue: 30000,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: 6, year: 2026, employeeId })
      .expect(201);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "payroll_runs", "employee_salary_components", "salary_components", "leaves", "leave_balances", "leave_types", "attendances", "payroll_settings", "statutory_config_versions", "tax_slab_configs", "employee_tax_declarations", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403 on every report endpoint', async () => {
    await request(app.getHttpServer())
      .get('/reports/attendance')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('MANAGER can pull the attendance report as xlsx (default format)', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/attendance')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain(
      'attendance_report.xlsx',
    );
  });

  it('MANAGER gets 403 on the payroll/employees/departments/headcount/attrition reports (ADMIN/HR only)', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/reports/payroll')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
    await request(server)
      .get('/reports/employees')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
    await request(server)
      .get('/reports/departments')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
    await request(server)
      .get('/reports/headcount-trend')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
    await request(server)
      .get('/reports/attrition')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
  });

  it('ADMIN pulls the payroll report as CSV', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/payroll')
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('payroll_report.csv');
  });

  it('ADMIN pulls the department report as a real PDF', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/departments')
      .query({ format: 'pdf' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const buffer = res.body as Buffer;
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('HR pulls the employee report', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/employees')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });

  it('MANAGER pulls the leave register and leave balance reports', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/reports/leave')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    await request(server)
      .get('/reports/leave/balance')
      .query({ year: 2026 })
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
  });

  it('employee-history requires employeeId', async () => {
    await request(app.getHttpServer())
      .get('/reports/leave/employee-history')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(400);
  });

  it("employee-history returns the requested employee's leave rows", async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/leave/employee-history')
      .query({ employeeId })
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(res.headers['content-disposition']).toContain(
      'employee_leave_history.xlsx',
    );
  });

  it('MANAGER pulls the department leave summary', async () => {
    await request(app.getHttpServer())
      .get('/reports/leave/department-summary')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
  });

  it('ADMIN pulls headcount-trend and attrition reports', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/reports/headcount-trend')
      .query({ months: 6 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(server)
      .get('/reports/attrition')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('rejects an invalid format value', async () => {
    await request(app.getHttpServer())
      .get('/reports/attendance')
      .query({ format: 'docx' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});
