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
interface TimelineEvent {
  id: string;
  eventKey: string;
  category: string;
  title: string;
}
interface TimelineListBody {
  events: TimelineEvent[];
  categories: { value: string; label: string }[];
}

const PASSWORD = 'TestPass123!';

describe('Employee Timeline (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let employeeToken: string;
  let otherEmployeeToken: string;
  let employeeId: string;
  let otherEmployeeId: string;

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
      organizationName: 'Timeline E2E Org',
      name: 'Founder',
      email: 'tl-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'tl-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'HR Person', email: 'tl-e2e-hr@example.test', role: 'HR' });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'tl-e2e-hr@example.test',
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
        email: 'tl-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'tl-e2e-manager@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'tl-e2e-emp@example.test',
        departmentId,
      });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'tl-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const otherCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Other Employee', email: 'tl-e2e-other@example.test' });
    const otherBody = otherCreate.body as EmployeeCreateBody;
    otherEmployeeId = otherBody.employee.id;
    const otherLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'tl-e2e-other@example.test',
        password: otherBody.generatedPassword,
      });
    otherEmployeeToken = (otherLogin.body as AuthBody).accessToken;

    // Produce a real PAYROLL_PROCESSED event via the payroll lock flow.
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
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "employee_timeline", "audit_logs", "payroll_runs", "employee_salary_components", "salary_components", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('the owning EMPLOYEE can view their own timeline and sees the PAYROLL_PROCESSED event', async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/timeline`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const body = res.body as TimelineListBody;
    expect(body.categories).toHaveLength(8);
    expect(body.events.some((e) => e.eventKey === 'PAYROLL_PROCESSED')).toBe(
      true,
    );
  });

  it("an EMPLOYEE gets 403 viewing another employee's timeline", async () => {
    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/timeline`)
      .set('Authorization', `Bearer ${otherEmployeeToken}`)
      .expect(403);
  });

  it("a MANAGER can view their own department's employee timeline", async () => {
    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/timeline`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
  });

  it('a MANAGER gets 403 viewing an employee outside their department', async () => {
    await request(app.getHttpServer())
      .get(`/employees/${otherEmployeeId}/timeline`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
  });

  it('ADMIN and HR can view anyone', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get(`/employees/${otherEmployeeId}/timeline`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(server)
      .get(`/employees/${employeeId}/timeline`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
  });

  it('filters by category', async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/timeline`)
      .query({ category: 'PAYROLL' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as TimelineListBody;
    expect(body.events.every((e) => e.category === 'PAYROLL')).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
  });

  it('search matches the event title', async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/timeline`)
      .query({ search: 'Payroll Processed' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as TimelineListBody;
    expect(body.events.some((e) => e.eventKey === 'PAYROLL_PROCESSED')).toBe(
      true,
    );
  });

  it('a category with no matching events returns an empty list, not an error', async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/timeline`)
      .query({ category: 'RECRUITMENT' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((res.body as TimelineListBody).events).toEqual([]);
  });

  it('exports as xlsx', async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/timeline/export/excel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('timeline.xlsx');
  });

  it('exports as a real pdf', async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/timeline/export/pdf`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const buffer = res.body as Buffer;
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('404s for a non-existent employee id', async () => {
    await request(app.getHttpServer())
      .get('/employees/00000000-0000-4000-8000-000000000000/timeline')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
