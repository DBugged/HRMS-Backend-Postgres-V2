import * as path from 'path';
import { compareEmployeeId } from '../src/common/employee-order';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EmailService } from '../src/notifications/email.service';

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
  data: { id: string; employeeId: string; departmentId: string | null }[];
  total: number;
  page: number;
  limit: number;
}
interface ListDepartmentsBody {
  data: { id: string }[];
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

  it('accepts optional shift config at creation time', async () => {
    const res = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        name: 'Support',
        code: 'SUP',
        shiftStartTime: '08:00',
        shiftEndTime: '16:00',
        weeklyOffs: [0, 6],
      })
      .expect(201);
    const body = res.body as { shiftStartTime: string; weeklyOffs: number[] };
    expect(body.shiftStartTime).toBe('08:00');
    expect(body.weeklyOffs).toEqual([0, 6]);
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
    expect((res.body as ListDepartmentsBody).data).toHaveLength(3);
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
    // Employee IDs are issued from the org's own documentNumbering.
    // employeeId config (see EmployeeIdService/issueDocumentNumber), not a
    // hardcoded "EMP-" prefix — a freshly-registered org's schema default
    // for that entry is "DP-{00000}" (see Organization.documentNumbering's
    // own default in schema.prisma).
    expect(managerBody.employee.employeeId).toMatch(/^DP-\d{5}$/);

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

  describe('welcome email + officialEmail + resend credentials', () => {
    let welcomeEmployeeId: string;

    it('creating an employee with personalEmail stores it in personalData and still returns generatedPassword (email delivery is best-effort/dry-run, not a precondition of success)', async () => {
      const res = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          name: 'Welcome Email Employee',
          email: 'employees-e2e-welcome@example.test',
          personalEmail: 'employees-e2e-welcome-personal@example.test',
          departmentId: engDepartmentId,
        })
        .expect(201);
      const body = res.body as EmployeeBody & {
        employee: { personalData: { personalEmail?: string } };
      };
      expect(body.generatedPassword).toBeTruthy();
      expect(body.employee.personalData.personalEmail).toBe(
        'employees-e2e-welcome-personal@example.test',
      );
      welcomeEmployeeId = body.employee.id;
    });

    it('creating an employee without personalEmail still succeeds (bulk-import path has no per-row personalEmail column)', async () => {
      await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          name: 'No Personal Email Employee',
          email: 'employees-e2e-no-personal-email@example.test',
          departmentId: engDepartmentId,
        })
        .expect(201);
    });

    it('resend-credentials fails with no officialEmail on file yet', async () => {
      await request(app.getHttpServer())
        .post(`/employees/${welcomeEmployeeId}/resend-credentials`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(409);
    });

    it('HR sets officialEmail via PATCH /employees/:id, then resend-credentials succeeds and forces a password change', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${welcomeEmployeeId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ officialEmail: 'employees-e2e-welcome-official@example.test' })
        .expect(200);

      const resendRes = await request(app.getHttpServer())
        .post(`/employees/${welcomeEmployeeId}/resend-credentials`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(201);
      expect((resendRes.body as { sentTo: string }).sentTo).toBe(
        'employees-e2e-welcome-official@example.test',
      );

      const employee = await prisma.user.findUniqueOrThrow({
        where: { id: welcomeEmployeeId },
      });
      expect(employee.mustChangePassword).toBe(true);
    });

    it('EMPLOYEE cannot resend-credentials (HR/Admin-only)', async () => {
      await request(app.getHttpServer())
        .post(`/employees/${welcomeEmployeeId}/resend-credentials`)
        .set('Authorization', `Bearer ${engEmployeeToken}`)
        .expect(403);
    });

    it('two employees cannot share the same officialEmail', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${engEmployeeId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ officialEmail: 'employees-e2e-welcome-official@example.test' })
        .expect(409); // AllExceptionsFilter now maps Prisma P2002 to a proper Conflict instead of an unmapped 500
    });
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

  it('lists employees by employee ID ascending by default', async () => {
    const res = await request(app.getHttpServer())
      .get('/employees')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    const codes = (res.body as ListEmployeesBody).data.map((e) => e.employeeId);
    expect(codes.length).toBeGreaterThan(1);
    expect(codes).toEqual([...codes].sort(compareEmployeeId));
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

  it('self-update can set profileImage, which comes back as a signed /files/ URL', async () => {
    await request(app.getHttpServer())
      .patch(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${engEmployeeToken}`)
      .send({ profileImage: 'profile-photos/self.jpg' })
      .expect(200);

    const check = await request(app.getHttpServer())
      .get(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${engEmployeeToken}`)
      .expect(200);
    expect((check.body as { profileImage: string }).profileImage).toMatch(
      /^\/files\//,
    );
  });

  it('self-update can set gender (feeds LeaveType.applicableGenders eligibility)', async () => {
    await request(app.getHttpServer())
      .patch(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${engEmployeeToken}`)
      .send({ gender: 'FEMALE' })
      .expect(200);

    const check = await request(app.getHttpServer())
      .get(`/employees/${engEmployeeId}`)
      .set('Authorization', `Bearer ${engEmployeeToken}`)
      .expect(200);
    expect((check.body as { gender: string }).gender).toBe('FEMALE');
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

  describe('list sorting (server-side sortBy/sortOrder)', () => {
    it('sorts by name asc/desc and rejects a non-whitelisted sortBy', async () => {
      const asc = await request(app.getHttpServer())
        .get('/employees')
        .query({ sortBy: 'name', sortOrder: 'asc', limit: 2000 })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const desc = await request(app.getHttpServer())
        .get('/employees')
        .query({ sortBy: 'name', sortOrder: 'desc', limit: 2000 })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const ascNames = (asc.body as ListEmployeesBody).data.map(
        (e) => (e as unknown as { name: string }).name,
      );
      const descNames = (desc.body as ListEmployeesBody).data.map(
        (e) => (e as unknown as { name: string }).name,
      );
      expect(ascNames.length).toBeGreaterThan(1);
      expect(descNames[0]).toBe(ascNames[ascNames.length - 1]);
      expect(descNames[descNames.length - 1]).toBe(ascNames[0]);

      await request(app.getHttpServer())
        .get('/employees')
        .query({ sortBy: 'password' })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(400);
    });
  });

  describe('reporting-manager chain + employment-status lifecycle', () => {
    let aId: string;
    let bId: string;
    let cId: string;
    let cEmail: string;
    let cPassword: string;

    async function createEmp(label: string) {
      const email = `employees-e2e-lifecycle-${label}@example.test`;
      const res = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          name: `Lifecycle ${label}`,
          email,
          departmentId: engDepartmentId,
        })
        .expect(201);
      const body = res.body as EmployeeBody;
      return { id: body.employee.id, email, password: body.generatedPassword };
    }

    beforeAll(async () => {
      aId = (await createEmp('a')).id;
      bId = (await createEmp('b')).id;
      const c = await createEmp('c');
      cId = c.id;
      cEmail = c.email;
      cPassword = c.password;
    });

    it('rejects an employee as their own reporting manager', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${aId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ reportingManagerId: aId })
        .expect(400);
    });

    it('rejects a reporting manager that would close a cycle', async () => {
      // B reports to A — fine.
      await request(app.getHttpServer())
        .patch(`/employees/${bId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ reportingManagerId: aId })
        .expect(200);
      // A reporting to B would make A → B → A.
      await request(app.getHttpServer())
        .patch(`/employees/${aId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ reportingManagerId: bId })
        .expect(400);
      const a = await prisma.user.findUniqueOrThrow({ where: { id: aId } });
      expect(a.reportingManagerId).toBeNull();
    });

    it('rejects an employment-status transition outside the lifecycle', async () => {
      // ONBOARDING → NOTICE_PERIOD is not allowed.
      await request(app.getHttpServer())
        .patch(`/employees/${cId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ employmentStatus: 'NOTICE_PERIOD' })
        .expect(400);
      // ONBOARDING → CONFIRMED is.
      await request(app.getHttpServer())
        .patch(`/employees/${cId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ employmentStatus: 'CONFIRMED' })
        .expect(200);
    });

    it('moving to TERMINATED deactivates, revokes sessions and blocks login; the status is then final', async () => {
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: cEmail, password: cPassword })
        .expect(201);
      const refreshToken = (login.body as { refreshToken: string })
        .refreshToken;

      const res = await request(app.getHttpServer())
        .patch(`/employees/${cId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ employmentStatus: 'TERMINATED' })
        .expect(200);
      expect((res.body as { isActive: boolean }).isActive).toBe(false);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: cEmail, password: cPassword })
        .expect(401);
      const live = await prisma.refreshToken.count({
        where: { userId: cId, revokedAt: null },
      });
      expect(live).toBe(0);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(401);

      // Can't be resurrected by reactivation either.
      await request(app.getHttpServer())
        .patch(`/employees/${cId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ isActive: true })
        .expect(400);
    });

    it('login is refused for an exit status even if isActive was left true', async () => {
      await prisma.user.update({
        where: { id: cId },
        data: { isActive: true },
      });
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: cEmail, password: cPassword })
        .expect(401);
      await prisma.user.update({
        where: { id: cId },
        data: { isActive: false },
      });
    });
  });

  it('HR deactivates an employee', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/employees/${salesEmployeeId}/deactivate`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    expect((res.body as { isActive: boolean }).isActive).toBe(false);
  });

  describe('department management', () => {
    interface DepartmentDetail {
      id: string;
      name: string;
      shiftStartTime: string;
      isActive: boolean;
      departmentHead: { id: string; name: string } | null;
    }

    it('HR updates a department shift config', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/departments/${salesDepartmentId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ shiftStartTime: '10:00', lateInThresholdMinutes: 20 })
        .expect(200);
      const body = res.body as DepartmentDetail & {
        lateInThresholdMinutes: number;
      };
      expect(body.shiftStartTime).toBe('10:00');
      expect(body.lateInThresholdMinutes).toBe(20);
    });

    it('refuses to deactivate a department that still has employees mapped, allows it once empty', async () => {
      await request(app.getHttpServer())
        .patch(`/departments/${engDepartmentId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ isActive: false })
        .expect(400);

      const empty = await request(app.getHttpServer())
        .post('/departments')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ name: 'Empty Dept E2E', code: 'EMPTYE2E' })
        .expect(201);
      const res = await request(app.getHttpServer())
        .patch(`/departments/${(empty.body as { id: string }).id}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ isActive: false })
        .expect(200);
      expect((res.body as DepartmentDetail).isActive).toBe(false);
    });

    it('EMPLOYEE cannot update a department (HR/Admin-only)', async () => {
      await request(app.getHttpServer())
        .patch(`/departments/${salesDepartmentId}`)
        .set('Authorization', `Bearer ${engEmployeeToken}`)
        .send({ shiftStartTime: '11:00' })
        .expect(403);
    });

    it('assigning a plain EMPLOYEE as department head promotes them to MANAGER and stamps the department', async () => {
      const res = await request(app.getHttpServer())
        .post(`/departments/${salesDepartmentId}/assign-head`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ userId: salesEmployeeId })
        .expect(201);
      const body = res.body as DepartmentDetail;
      expect(body.departmentHead?.id).toBe(salesEmployeeId);

      const check = await request(app.getHttpServer())
        .get(`/employees/${salesEmployeeId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect((check.body as EmployeeBody['employee']).role).toBe('MANAGER');
    });

    it('refuses to assign an ADMIN/HR account as department head (already broader authority)', async () => {
      const hrList = await request(app.getHttpServer())
        .get('/employees')
        .query({ role: 'HR' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const hrUserId = (hrList.body as ListEmployeesBody).data[0].id;

      await request(app.getHttpServer())
        .post(`/departments/${salesDepartmentId}/assign-head`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: hrUserId })
        .expect(400);
    });

    it('maps employees to a department', async () => {
      const res = await request(app.getHttpServer())
        .post(`/departments/${engDepartmentId}/map-employees`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ employeeIds: [salesEmployeeId] })
        .expect(201);
      expect((res.body as { message: string }).message).toMatch(/1 employee/);

      const check = await request(app.getHttpServer())
        .get(`/employees/${salesEmployeeId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect((check.body as EmployeeBody['employee']).departmentId).toBe(
        engDepartmentId,
      );
    });

    it('refuses to delete a department that still has employees mapped to it', async () => {
      await request(app.getHttpServer())
        .delete(`/departments/${engDepartmentId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(400);
    });

    it('deletes an empty department', async () => {
      const empty = await request(app.getHttpServer())
        .post('/departments')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ name: 'Temp Dept', code: 'TMP' })
        .expect(201);
      const tempId = (empty.body as DepartmentBody).id;

      await request(app.getHttpServer())
        .delete(`/departments/${tempId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
    });
  });

  describe('bulk create', () => {
    // Matches the manual "Add Employee" form, which requires personalEmail/
    // department/employeeCategory/role/employeeType — bulk rows now require
    // them too instead of silently skipping them (which used to mean
    // bulk-imported employees never got personalEmail set and so never got
    // a welcome email).
    const validRow = (overrides: Record<string, unknown> = {}) => ({
      name: 'Bulk Valid',
      email: 'employees-e2e-bulk-valid@example.test',
      personalEmail: 'employees-e2e-bulk-valid-personal@example.test',
      department: 'Engineering',
      employeeCategory: 'Full-Time',
      role: 'EMPLOYEE',
      employeeType: 'permanent',
      gender: 'Female',
      ...overrides,
    });

    it('creates every valid row and isolates a bad one instead of aborting the batch', async () => {
      const res = await request(app.getHttpServer())
        .post('/employees/bulk')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          rows: [
            validRow({
              name: 'Bulk One',
              email: 'employees-e2e-bulk-1@example.test',
              personalEmail: 'employees-e2e-bulk-1-personal@example.test',
            }),
            validRow({
              name: 'Bulk Two',
              email: 'employees-e2e-eng-employee@example.test', // duplicate email — must fail in isolation
              personalEmail: 'employees-e2e-bulk-2-personal@example.test',
            }),
            validRow({
              name: 'Bulk Three',
              email: 'employees-e2e-bulk-3@example.test',
              personalEmail: 'employees-e2e-bulk-3-personal@example.test',
              department: 'Sales',
              role: 'MANAGER',
            }),
          ],
        })
        .expect(201);
      const body = res.body as {
        created: {
          employeeId: string;
          name: string;
          generatedPassword: string;
        }[];
        failed: { row: unknown; error: string }[];
      };
      expect(body.created.length).toBe(2);
      expect(body.failed.length).toBe(1);
      expect(body.failed[0].error).toMatch(/already exists/);
    });

    it('a valid row creates the employee with department/role/employeeType resolved and personalEmail stored (welcome email attempted)', async () => {
      const res = await request(app.getHttpServer())
        .post('/employees/bulk')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          rows: [
            validRow({
              name: 'Bulk Full Row',
              email: 'employees-e2e-bulk-full@example.test',
              personalEmail: 'employees-e2e-bulk-full-personal@example.test',
              department: 'engineering', // case-insensitive match
              employeeCategory: 'full-time',
              role: 'employee',
              employeeType: 'Permanent',
            }),
          ],
        })
        .expect(201);
      const body = res.body as {
        created: {
          employeeId: string;
          name: string;
          generatedPassword: string;
        }[];
        failed: { row: unknown; error: string }[];
      };
      expect(body.failed).toEqual([]);
      expect(body.created.length).toBe(1);

      const list = await request(app.getHttpServer())
        .get('/employees')
        .query({ search: 'Bulk Full Row' })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const emp = (
        list.body as {
          data: {
            id: string;
            departmentId: string;
            role: string;
            employeeType: string;
            employeeCategory: string;
          }[];
        }
      ).data[0];
      expect(emp.departmentId).toBe(engDepartmentId);
      expect(emp.role).toBe('EMPLOYEE');
      expect(emp.employeeType).toBe('permanent');
      expect(emp.employeeCategory).toBe('Full-Time');

      const detail = await request(app.getHttpServer())
        .get(`/employees/${emp.id}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect(
        (detail.body as { personalData: { personalEmail?: string } })
          .personalData.personalEmail,
      ).toBe('employees-e2e-bulk-full-personal@example.test');
    });

    it('an unknown department name fails that row with a clear error', async () => {
      const res = await request(app.getHttpServer())
        .post('/employees/bulk')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          rows: [
            validRow({
              name: 'Bulk Bad Dept',
              email: 'employees-e2e-bulk-bad-dept@example.test',
              personalEmail:
                'employees-e2e-bulk-bad-dept-personal@example.test',
              department: 'Nonexistent Department',
            }),
          ],
        })
        .expect(201);
      const body = res.body as {
        created: {
          employeeId: string;
          name: string;
          generatedPassword: string;
        }[];
        failed: { row: unknown; error: string }[];
      };
      expect(body.created.length).toBe(0);
      expect(body.failed.length).toBe(1);
      expect(body.failed[0].error).toBe(
        'Department "Nonexistent Department" not found.',
      );
    });

    it('an invalid role value fails that row', async () => {
      const res = await request(app.getHttpServer())
        .post('/employees/bulk')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          rows: [
            validRow({
              name: 'Bulk Bad Role',
              email: 'employees-e2e-bulk-bad-role@example.test',
              personalEmail:
                'employees-e2e-bulk-bad-role-personal@example.test',
              role: 'SUPERUSER',
            }),
          ],
        })
        .expect(201);
      const body = res.body as {
        created: {
          employeeId: string;
          name: string;
          generatedPassword: string;
        }[];
        failed: { row: unknown; error: string }[];
      };
      expect(body.created.length).toBe(0);
      expect(body.failed.length).toBe(1);
      expect(body.failed[0].error).toMatch(/not valid/);
    });

    it('an invalid gender value fails that row; a valid label is case-insensitively resolved to the enum', async () => {
      const bad = await request(app.getHttpServer())
        .post('/employees/bulk')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          rows: [
            validRow({
              name: 'Bulk Bad Gender',
              email: 'employees-e2e-bulk-bad-gender@example.test',
              personalEmail:
                'employees-e2e-bulk-bad-gender-personal@example.test',
              gender: 'Unknown',
            }),
          ],
        })
        .expect(201);
      const badBody = bad.body as { failed: { error: string }[] };
      expect(badBody.failed.length).toBe(1);
      expect(badBody.failed[0].error).toMatch(/not valid/);

      const ok = await request(app.getHttpServer())
        .post('/employees/bulk')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          rows: [
            validRow({
              name: 'Bulk Good Gender',
              email: 'employees-e2e-bulk-good-gender@example.test',
              personalEmail:
                'employees-e2e-bulk-good-gender-personal@example.test',
              gender: 'male', // lowercase, no underscore — same as the display label
            }),
          ],
        })
        .expect(201);
      const okBody = ok.body as { created: { employeeId: string }[] };
      expect(okBody.created.length).toBe(1);
    });

    it('rejects a row missing personalEmail/department/employeeCategory/role/employeeType, same required fields as the manual form', async () => {
      const res = await request(app.getHttpServer())
        .post('/employees/bulk')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          rows: [
            {
              name: 'Bulk Minimal',
              email: 'employees-e2e-bulk-minimal@example.test',
            },
          ],
        })
        .expect(201);
      const body = res.body as {
        created: {
          employeeId: string;
          name: string;
          generatedPassword: string;
        }[];
        failed: { row: unknown; error: string }[];
      };
      expect(body.created.length).toBe(0);
      expect(body.failed.length).toBe(1);
      // Gender is checked first among the shared-required fields — see
      // bulkCreate()'s validation order in employees.service.ts.
      expect(body.failed[0].error).toMatch(/Gender is required/);
    });

    it('sendWelcomeEmail: true (or omitted) still attempts the welcome email for every created row, unchanged', async () => {
      const emailService = app.get(EmailService);
      const sendSpy = jest
        .spyOn(emailService, 'send')
        .mockResolvedValue({ dryRun: true });
      try {
        const res = await request(app.getHttpServer())
          .post('/employees/bulk')
          .set('Authorization', `Bearer ${hrToken}`)
          .send({
            rows: [
              validRow({
                name: 'Bulk Email On',
                email: 'employees-e2e-bulk-email-on@example.test',
                personalEmail:
                  'employees-e2e-bulk-email-on-personal@example.test',
              }),
            ],
            // omitted defaults to true, but assert the explicit value too
            sendWelcomeEmail: true,
          })
          .expect(201);
        const body = res.body as {
          created: {
            employeeId: string;
            name: string;
            generatedPassword: string;
          }[];
          failed: { row: unknown; error: string }[];
        };
        expect(body.failed).toEqual([]);
        expect(body.created.length).toBe(1);
        expect(body.created[0].generatedPassword).toEqual(expect.any(String));
        expect(body.created[0].generatedPassword.length).toBeGreaterThan(0);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            to: 'employees-e2e-bulk-email-on-personal@example.test',
          }),
        );
      } finally {
        sendSpy.mockRestore();
      }
    });

    it('sendWelcomeEmail: false still creates every row and returns a usable generatedPassword, but sends no email', async () => {
      const emailService = app.get(EmailService);
      const sendSpy = jest
        .spyOn(emailService, 'send')
        .mockResolvedValue({ dryRun: true });
      try {
        const res = await request(app.getHttpServer())
          .post('/employees/bulk')
          .set('Authorization', `Bearer ${hrToken}`)
          .send({
            rows: [
              validRow({
                name: 'Bulk No Email',
                email: 'employees-e2e-bulk-no-email@example.test',
                personalEmail:
                  'employees-e2e-bulk-no-email-personal@example.test',
              }),
            ],
            sendWelcomeEmail: false,
          })
          .expect(201);
        const body = res.body as {
          created: {
            employeeId: string;
            name: string;
            generatedPassword: string;
          }[];
          failed: { row: unknown; error: string }[];
        };
        expect(body.failed).toEqual([]);
        expect(body.created.length).toBe(1);
        expect(body.created[0].name).toBe('Bulk No Email');
        expect(body.created[0].generatedPassword).toEqual(expect.any(String));
        expect(body.created[0].generatedPassword.length).toBeGreaterThan(0);
        // No welcome email attempted for this batch.
        expect(sendSpy).not.toHaveBeenCalled();

        // The returned password actually logs the employee in.
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({
            email: 'employees-e2e-bulk-no-email@example.test',
            password: body.created[0].generatedPassword,
          })
          .expect(201);
      } finally {
        sendSpy.mockRestore();
      }
    });

    it('EMPLOYEE cannot bulk-create (HR/Admin-only)', async () => {
      await request(app.getHttpServer())
        .post('/employees/bulk')
        .set('Authorization', `Bearer ${engEmployeeToken}`)
        .send({
          rows: [
            validRow({
              name: 'Nope',
              email: 'employees-e2e-bulk-nope@example.test',
              personalEmail: 'employees-e2e-bulk-nope-personal@example.test',
            }),
          ],
        })
        .expect(403);
    });

    it('rejects an empty rows array', async () => {
      await request(app.getHttpServer())
        .post('/employees/bulk')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ rows: [] })
        .expect(400);
    });
  });
});
