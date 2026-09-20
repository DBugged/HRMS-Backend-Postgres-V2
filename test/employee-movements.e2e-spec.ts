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
interface MovementBody {
  type: string;
  effectiveDate: string;
  reason: string | null;
  previousDepartmentId: string | null;
  newDepartmentId: string | null;
  newGradeLevel: string | null;
  newReportingManagerId: string | null;
}

const PASSWORD = 'TestPass123!';

describe('Employee movement history (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let hrToken: string;
  let empToken: string;
  let otherToken: string;
  let empId: string;
  let managerId: string;
  let deptId: string;

  async function createEmployee(email: string, role?: string) {
    const res = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: email.split('@')[0], email, ...(role && { role }) });
    const body = res.body as EmployeeCreateBody;
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: body.generatedPassword });
    return {
      id: body.employee.id,
      token: (login.body as AuthBody).accessToken,
    };
  }

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
      organizationName: 'Movements E2E Org',
      name: 'Founder',
      email: 'move-e2e-admin@example.test',
      password: PASSWORD,
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'move-e2e-admin@example.test', password: PASSWORD });
    adminToken = (login.body as AuthBody).accessToken;
    const organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'move-e2e-admin@example.test' },
      })
    ).organizationId;

    hrToken = (await createEmployee('move-e2e-hr@example.test', 'HR')).token;
    const emp = await createEmployee('move-e2e-emp@example.test');
    empId = emp.id;
    empToken = emp.token;
    otherToken = (await createEmployee('move-e2e-other@example.test')).token;
    managerId = (await createEmployee('move-e2e-mgr@example.test', 'MANAGER'))
      .id;
    deptId = (
      await prisma.department.create({
        data: { organizationId, name: 'Movement Dept', code: 'MOV' },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "employee_movements", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('writes TRANSFER, PROMOTION and MANAGER_CHANGE rows from PATCH /employees/:id', async () => {
    await request(app.getHttpServer())
      .patch(`/employees/${empId}`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        departmentId: deptId,
        gradeLevel: 'L3',
        reportingManagerId: managerId,
        isPromotion: true,
        effectiveDate: '2026-10-01',
        changeReason: 'Annual review',
      })
      .expect(200);

    // Values are applied immediately, regardless of effectiveDate.
    const user = await prisma.user.findFirstOrThrow({ where: { id: empId } });
    expect(user.departmentId).toBe(deptId);
    expect(user.gradeLevel).toBe('L3');

    const res = await request(app.getHttpServer())
      .get(`/employees/${empId}/movements`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    const rows = res.body as MovementBody[];
    expect(rows.map((r) => r.type).sort()).toEqual([
      'MANAGER_CHANGE',
      'PROMOTION',
      'TRANSFER',
    ]);
    expect(rows.every((r) => r.effectiveDate === '2026-10-01')).toBe(true);
    expect(rows.every((r) => r.reason === 'Annual review')).toBe(true);
    expect(rows.find((r) => r.type === 'TRANSFER')?.newDepartmentId).toBe(
      deptId,
    );
    expect(rows.find((r) => r.type === 'PROMOTION')?.newGradeLevel).toBe('L3');
    expect(
      rows.find((r) => r.type === 'MANAGER_CHANGE')?.newReportingManagerId,
    ).toBe(managerId);

    const keys = (
      await prisma.employeeTimeline.findMany({ where: { employeeId: empId } })
    ).map((e) => e.eventKey);
    expect(keys).toEqual(
      expect.arrayContaining(['PROMOTION', 'REPORTING_MANAGER_CHANGED']),
    );
  });

  it('a non-promotion grade change is a DESIGNATION_CHANGE and effectiveDate defaults to today', async () => {
    await request(app.getHttpServer())
      .patch(`/employees/${empId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ gradeLevel: 'L4' })
      .expect(200);
    const rows = await prisma.employeeMovement.findMany({
      where: { employeeId: empId, type: 'DESIGNATION_CHANGE' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('an update that changes none of the tracked fields writes no movement', async () => {
    const before = await prisma.employeeMovement.count();
    await request(app.getHttpServer())
      .patch(`/employees/${empId}`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ gradeLevel: 'L4', changeReason: 'noop' })
      .expect(200);
    expect(await prisma.employeeMovement.count()).toBe(before);
  });

  it('self can read their own movements; another employee cannot', async () => {
    await request(app.getHttpServer())
      .get(`/employees/${empId}/movements`)
      .set('Authorization', `Bearer ${empToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/employees/${empId}/movements`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);
  });
});
