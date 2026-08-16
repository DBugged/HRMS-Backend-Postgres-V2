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
interface AuditLogEntry {
  id: string;
  action: string;
  module: string;
  targetId: string | null;
  actor: { id: string; name: string; role: string };
}
interface AuditLogListBody {
  total: number;
  page: number;
  limit: number;
  data: AuditLogEntry[];
}

const PASSWORD = 'TestPass123!';

describe('Audit Log (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let employeeToken: string;
  let adminId: string;
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
      organizationName: 'Audit Log E2E Org',
      name: 'Founder',
      email: 'audit-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'audit-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'audit-e2e-admin@example.test' },
    });
    adminId = admin.id;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'audit-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'audit-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const managerCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'A Manager',
        email: 'audit-e2e-manager@example.test',
        role: 'MANAGER',
      });
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'audit-e2e-manager@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'audit-e2e-emp@example.test' });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'audit-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "audit_logs", "offboarding_cases", "settlements", "payroll_runs", "employee_salary_components", "salary_components", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE and MANAGER get 403 listing audit logs', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/audit-logs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
    await request(server)
      .get('/audit-logs')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
  });

  it('ADMIN sees a LOGIN entry for every login that happened during setup', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ module: 'AUTH', action: 'LOGIN' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as AuditLogListBody;
    expect(body.total).toBeGreaterThanOrEqual(4); // admin+hr+manager+employee logins
    expect(body.data.some((l) => l.actor.id === adminId)).toBe(true);
  });

  it("ADMIN's actor filter narrows to one user's logins", async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ actor: adminId })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as AuditLogListBody;
    expect(body.data.every((l) => l.actor.id === adminId)).toBe(true);
  });

  it("HR's view hides ADMIN and MANAGER actor activity, but keeps EMPLOYEE/HR activity", async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    const body = res.body as AuditLogListBody;
    expect(body.data.some((l) => l.actor.id === adminId)).toBe(false);
    expect(
      body.data.every((l) => !['ADMIN', 'MANAGER'].includes(l.actor.role)),
    ).toBe(true);
  });

  it('supports pagination', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ page: 1, limit: 1 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as AuditLogListBody;
    expect(body.data.length).toBe(1);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(1);
  });

  it('rejects a ?limit= above the 2000 hard cap', async () => {
    await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ limit: 2001 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('payroll lock/pay produce PAYROLL_LOCKED/PAYROLL_PAID entries', async () => {
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
    const calc = await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: 6, year: 2026, employeeId })
      .expect(201);
    const runId = (calc.body as { payrolls: { id: string }[] }).payrolls[0].id;

    await request(app.getHttpServer())
      .post(`/payroll/${runId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/payroll/${runId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/payroll/${runId}/lock`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/payroll/${runId}/pay`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ module: 'PAYROLL' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as AuditLogListBody;
    expect(
      body.data.some(
        (l) => l.action === 'PAYROLL_LOCKED' && l.targetId === runId,
      ),
    ).toBe(true);
    expect(
      body.data.some(
        (l) => l.action === 'PAYROLL_PAID' && l.targetId === runId,
      ),
    ).toBe(true);
  });

  it('completing an offboarding case produces an EMPLOYEE_DEACTIVATED entry', async () => {
    const initiate = await request(app.getHttpServer())
      .post('/offboarding')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeId, lastWorkingDay: '2026-07-01' })
      .expect(201);
    const caseId = (initiate.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/checklist`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assetsReturned: true, accessRevoked: true })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/exit-interview`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonForLeaving: 'Career Growth', overallExperience: 4 })
      .expect(200);
    const settlement = await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeId, lastWorkingDay: '2026-07-01' })
      .expect(201);
    const settlementId = (settlement.body as { id: string }).id;
    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/settlement`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ settlementId })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/complete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ module: 'EMPLOYEE', action: 'EMPLOYEE_DEACTIVATED' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as AuditLogListBody;
    expect(body.data.some((l) => l.targetId === employeeId)).toBe(true);
  });
});
