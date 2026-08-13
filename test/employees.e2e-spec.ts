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
  user: { role: string };
}
interface EmployeeBody {
  employee: {
    id: string;
    employeeId: string;
    departmentId: string | null;
    role: string;
    designation: string;
  };
  generatedPassword: string;
}
interface DepartmentBody {
  id: string;
}
interface ListEmployeesBody {
  data: { id: string; departmentId: string | null }[];
  total: number;
  page: number;
  limit: number;
}

const PASSWORD = 'TestPass123!';

describe('Employees + Departments (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let engDepartmentId: string;
  let salesDepartmentId: string;

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

    // Founder (ADMIN) + one HR account created via the real endpoints —
    // this is also the manual-verification flow now that seed-qa-users.ts
    // has been retired in favor of using POST /employees itself.
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Employees E2E Org',
        name: 'Founder',
        email: 'employees-e2e-admin@example.test',
        password: PASSWORD,
      });
    const organizationId = (registerRes.body as { organizationId: string })
      .organizationId;

    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'employees-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'employees-e2e-hr@example.test',
        role: 'HR',
      });
    const hrGeneratedPassword = (hrCreate.body as EmployeeBody)
      .generatedPassword;
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'employees-e2e-hr@example.test',
        password: hrGeneratedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    void organizationId; // kept for readability of setup; not asserted on directly below
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('HR creates two departments', async () => {
    const eng = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ name: 'Engineering', code: 'eng' }) // lowercase, service should uppercase it
      .expect(201);
    expect((eng.body as { code: string }).code).toBe('ENG');
    engDepartmentId = (eng.body as DepartmentBody).id;

    const sales = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ name: 'Sales', code: 'SALES' })
      .expect(201);
    salesDepartmentId = (sales.body as DepartmentBody).id;
  });

  it('rejects a duplicate department name/code', async () => {
    await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ name: 'Engineering', code: 'ENG2' })
      .expect(409);
  });

  it('any authenticated caller can list departments (no @Roles restriction)', async () => {
    const res = await request(app.getHttpServer())
      .get('/departments')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    expect(res.body).toHaveLength(2);
  });

  let engManagerToken: string;
  let engEmployeeId: string;
  let engEmployeeToken: string;
  let salesEmployeeId: string;

  it('HR creates a MANAGER in Engineering, then an EMPLOYEE in Engineering, then an EMPLOYEE in Sales', async () => {
    const managerRes = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        name: 'Eng Manager',
        email: 'employees-e2e-eng-manager@example.test',
        role: 'MANAGER',
        departmentId: engDepartmentId,
      })
      .expect(201);
    const managerBody = managerRes.body as EmployeeBody;
    expect(managerBody.employee.employeeId).toMatch(/^EMP-\d{4}$/);

    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'employees-e2e-eng-manager@example.test',
        password: managerBody.generatedPassword,
      });
    engManagerToken = (managerLogin.body as AuthBody).accessToken;

    const empRes = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        name: 'Eng Employee',
        email: 'employees-e2e-eng-employee@example.test',
        departmentId: engDepartmentId,
      })
      .expect(201);
    const empBody = empRes.body as EmployeeBody;
    engEmployeeId = empBody.employee.id;
    expect(empBody.employee.role).toBe('EMPLOYEE'); // default when role omitted

    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'employees-e2e-eng-employee@example.test',
        password: empBody.generatedPassword,
      });
    engEmployeeToken = (empLogin.body as AuthBody).accessToken;

    const salesEmpRes = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        name: 'Sales Employee',
        email: 'employees-e2e-sales-employee@example.test',
        departmentId: salesDepartmentId,
      })
      .expect(201);
    salesEmployeeId = (salesEmpRes.body as EmployeeBody).employee.id;
  });

  it('HR cannot create an ADMIN account (role-assignability check)', async () => {
    await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        name: 'Sneaky',
        email: 'employees-e2e-sneaky@example.test',
        role: 'ADMIN',
      })
      .expect(403);
  });

  it('sequential employeeIds are distinct across concurrent creates (the race-condition regression check)', async () => {
    const [a, b] = await Promise.all([
      request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          name: 'Concurrent A',
          email: 'employees-e2e-concurrent-a@example.test',
        }),
      request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          name: 'Concurrent B',
          email: 'employees-e2e-concurrent-b@example.test',
        }),
    ]);
    const idA = (a.body as EmployeeBody).employee.employeeId;
    const idB = (b.body as EmployeeBody).employee.employeeId;
    expect(idA).not.toBe(idB);
  });

  it('EMPLOYEE gets 403 on the list endpoint (only ADMIN/HR/MANAGER may list)', async () => {
    await request(app.getHttpServer())
      .get('/employees')
      .set('Authorization', `Bearer ${engEmployeeToken}`)
      .expect(403);
  });

  it('MANAGER listing employees only sees their own department, regardless of what they ask for', async () => {
    const res = await request(app.getHttpServer())
      .get('/employees')
      .query({ department: salesDepartmentId }) // deliberately requesting the OTHER department
      .set('Authorization', `Bearer ${engManagerToken}`)
      .expect(200);
    const body = res.body as ListEmployeesBody;
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((e) => e.departmentId === engDepartmentId)).toBe(
      true,
    );
  });

  it('ADMIN/HR listing employees can filter by any department', async () => {
    const res = await request(app.getHttpServer())
      .get('/employees')
      .query({ department: salesDepartmentId })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as ListEmployeesBody;
    expect(body.data.every((e) => e.departmentId === salesDepartmentId)).toBe(
      true,
    );
  });

  it('list response includes page/limit (an intentional small improvement over the old system, which omitted limit)', async () => {
    const res = await request(app.getHttpServer())
      .get('/employees')
      .query({ page: 1, limit: 5 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as ListEmployeesBody;
    expect(body.page).toBe(1);
    expect(body.limit).toBe(5);
    expect(typeof body.total).toBe('number');
  });

  it('EMPLOYEE can view their own record (self)', async () => {
    await request(app.getHttpServer())
      .get(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${engEmployeeToken}`)
      .expect(200);
  });

  it('EMPLOYEE gets 403 viewing a different employee', async () => {
    await request(app.getHttpServer())
      .get(`/employees/${salesEmployeeId}`)
      .set('Authorization', `Bearer ${engEmployeeToken}`)
      .expect(403);
  });

  it('MANAGER can view an employee in their own department, but not one in another department', async () => {
    await request(app.getHttpServer())
      .get(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${engManagerToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/employees/${salesEmployeeId}`)
      .set('Authorization', `Bearer ${engManagerToken}`)
      .expect(403);
  });

  it('self-update strips locked fields silently — role/department/designation stay unchanged, name applies', async () => {
    await request(app.getHttpServer())
      .patch(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${engEmployeeToken}`)
      .send({
        name: 'Renamed By Self',
        role: 'ADMIN',
        departmentId: salesDepartmentId,
        designation: 'CEO',
      })
      .expect(200);

    const check = await request(app.getHttpServer())
      .get(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    const body = check.body as EmployeeBody['employee'];
    expect(body).toMatchObject({
      role: 'EMPLOYEE',
      departmentId: engDepartmentId,
      designation: '',
    });
  });

  it('MANAGER cannot update an employee at all (write access excludes MANAGER, unlike read)', async () => {
    await request(app.getHttpServer())
      .patch(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${engManagerToken}`)
      .send({ name: 'Should Not Apply' })
      .expect(403);
  });

  it('HR update applies locked fields but still cannot change designation (Admin-only)', async () => {
    await request(app.getHttpServer())
      .patch(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        departmentId: salesDepartmentId,
        designation: 'Should Not Apply',
      })
      .expect(200);

    const check = await request(app.getHttpServer())
      .get(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    const body = check.body as EmployeeBody['employee'];
    expect(body.departmentId).toBe(salesDepartmentId);
    expect(body.designation).toBe('');
  });

  it('ADMIN update can change designation', async () => {
    await request(app.getHttpServer())
      .patch(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ designation: 'Staff Engineer' })
      .expect(200);

    const check = await request(app.getHttpServer())
      .get(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((check.body as EmployeeBody['employee']).designation).toBe(
      'Staff Engineer',
    );
  });

  it('HR deactivates an employee', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/employees/${salesEmployeeId}/deactivate`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    expect((res.body as { isActive: boolean }).isActive).toBe(false);
  });
});
