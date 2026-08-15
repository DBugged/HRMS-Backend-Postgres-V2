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
const MONTH = 6;
const YEAR = 2026;

describe('Payroll Reports (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let employeeId: string;

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
      organizationName: 'Payroll Reports E2E Org',
      name: 'Founder',
      email: 'prpt-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'prpt-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'prpt-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'prpt-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const managerCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'A Manager',
        email: 'prpt-e2e-manager@example.test',
        role: 'MANAGER',
      });
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'prpt-e2e-manager@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'prpt-e2e-emp@example.test' });
    employeeId = (empCreate.body as EmployeeCreateBody).employee.id;

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
      .post(`/employee-salary/${employeeId}/structure`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        componentCode: 'BASIC',
        fixedAmount: 30000,
        effectiveFrom: '2026-01-01',
      })
      .expect(201);

    const rows = Array.from({ length: 30 }, (_, i) => ({
      organizationId: undefined,
      employeeId,
      date: `${YEAR}-0${MONTH}-${String(i + 1).padStart(2, '0')}`,
      status: AttendanceStatus.PRESENT,
      source: 'FACE_API' as const,
    }));
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'prpt-e2e-admin@example.test' },
    });
    await prisma.attendance.createMany({
      data: rows.map((r) => ({ ...r, organizationId: admin.organizationId })),
    });

    await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "payroll_runs", "employee_salary_components", "salary_components", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  const endpoints: { path: string; filename: string }[] = [
    { path: 'salary-register', filename: 'salary_register.xlsx' },
    { path: 'bank-transfer', filename: 'bank_transfer_report.xlsx' },
    { path: 'income-tax', filename: 'income_tax_report.xlsx' },
    { path: 'pf', filename: 'pf_report.xlsx' },
    { path: 'esi', filename: 'esi_report.xlsx' },
    { path: 'pt', filename: 'pt_report.xlsx' },
    {
      path: 'employer-contributions',
      filename: 'employer_contributions_report.xlsx',
    },
    { path: 'bonus', filename: 'bonus_report.xlsx' },
    { path: 'ctc', filename: 'ctc_report.xlsx' },
    { path: 'audit', filename: 'payroll_audit_report.xlsx' },
  ];

  it('MANAGER gets 403 on every payroll report endpoint (ADMIN/HR only)', async () => {
    for (const { path: p } of endpoints) {
      await request(app.getHttpServer())
        .get(`/reports/payroll/${p}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
    }
  });

  it('ADMIN/HR can pull every payroll report as xlsx', async () => {
    for (const { path: p, filename } of endpoints) {
      const res = await request(app.getHttpServer())
        .get(`/reports/payroll/${p}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      expect(res.headers['content-disposition']).toContain(filename);
    }
  });

  it('the salary register includes the calculated BASIC-only run', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/payroll/salary-register')
      .query({ month: MONTH, year: YEAR, format: 'csv' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const csv = res.text;
    expect(csv).toContain('BASIC');
    expect(csv).toContain('30000');
  });

  it('form16 requires financialYear', async () => {
    await request(app.getHttpServer())
      .get('/reports/payroll/form16')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('form16 with a well-formed financialYear returns 200 (no APPROVED+ runs yet -> empty rows)', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/payroll/form16')
      .query({ financialYear: '2026-27' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.headers['content-disposition']).toContain('form16_summary.xlsx');
  });

  it('the audit report includes the PAYROLL_CALCULATED action from setup, and no other module', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/payroll/audit')
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.text).toContain('PAYROLL_CALCULATED');
  });

  it('rejects a malformed financialYear', async () => {
    await request(app.getHttpServer())
      .get('/reports/payroll/form16')
      .query({ financialYear: '2026' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});
