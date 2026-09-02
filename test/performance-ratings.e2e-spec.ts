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
interface RatingBody {
  id: string;
  employeeId: string;
  financialYear: string;
  rating: number;
  payoutPercentage: number;
  status: string;
}

const PASSWORD = 'TestPass123!';

describe('Performance Ratings (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let managerToken: string;
  let employeeToken: string;
  let hrToken: string;
  let hrEmployeeId: string;
  let deptEmployeeId: string;
  let outsideEmployeeId: string;

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
      organizationName: 'Performance E2E Org',
      name: 'Founder',
      email: 'perf-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'perf-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

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
        email: 'perf-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'perf-e2e-manager@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const deptEmpCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Dept Employee',
        email: 'perf-e2e-deptemp@example.test',
        departmentId,
      });
    deptEmployeeId = (deptEmpCreate.body as EmployeeCreateBody).employee.id;

    const outsideCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Outside Employee',
        email: 'perf-e2e-outside@example.test',
      });
    outsideEmployeeId = (outsideCreate.body as EmployeeCreateBody).employee.id;

    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'perf-e2e-outside@example.test',
        password: (outsideCreate.body as EmployeeCreateBody).generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    // An HR user placed in the manager's own department, so the manager
    // can submit a rating for them — used to exercise the self-approval
    // block (an HR/Admin can't approve/reject their own rating).
    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'perf-e2e-hr@example.test',
        role: 'HR',
        departmentId,
      });
    hrEmployeeId = (hrCreate.body as EmployeeCreateBody).employee.id;
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'perf-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "performance_ratings", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403', async () => {
    await request(app.getHttpServer())
      .get('/performance-ratings')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('rejects an out-of-range rating and payoutPercentage', async () => {
    await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId: outsideEmployeeId,
        financialYear: '2026-27',
        rating: 6,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId: outsideEmployeeId,
        financialYear: '2026-27',
        rating: 3,
        payoutPercentage: 250,
      })
      .expect(400);
  });

  it('MANAGER gets 403 rating an employee outside their department', async () => {
    await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        employeeId: outsideEmployeeId,
        financialYear: '2026-27',
        rating: 4,
      })
      .expect(403);
  });

  it('MANAGER rates an employee in their own department; payoutPercentage defaults to 100', async () => {
    const res = await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ employeeId: deptEmployeeId, financialYear: '2026-27', rating: 4 })
      .expect(201);
    const body = res.body as RatingBody;
    expect(body.rating).toBe(4);
    expect(body.payoutPercentage).toBe(100);
  });

  it('upsert by (employee, financialYear) updates rather than duplicates', async () => {
    await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId: deptEmployeeId,
        financialYear: '2026-27',
        rating: 5,
        payoutPercentage: 150,
      })
      .expect(201);

    const count = await prisma.performanceRating.count({
      where: { employeeId: deptEmployeeId, financialYear: '2026-27' },
    });
    expect(count).toBe(1);

    const row = await prisma.performanceRating.findFirst({
      where: { employeeId: deptEmployeeId, financialYear: '2026-27' },
    });
    expect(row?.rating).toBe(5);
    expect(row?.payoutPercentage).toBe(150);
  });

  it("MANAGER's GET is scoped to their own department", async () => {
    await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId: outsideEmployeeId,
        financialYear: '2026-27',
        rating: 2,
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/performance-ratings')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const rows = (res.body as { data: RatingBody[] }).data;
    expect(rows.some((r) => r.employeeId === deptEmployeeId)).toBe(true);
    expect(rows.every((r) => r.employeeId !== outsideEmployeeId)).toBe(true);
  });

  describe('Manager-submits -> HR-approves workflow', () => {
    it('MANAGER upsert leaves status SUBMITTED and does not notify the employee', async () => {
      const before = await prisma.notification.count({
        where: { userId: deptEmployeeId },
      });

      const res = await request(app.getHttpServer())
        .post('/performance-ratings')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          employeeId: deptEmployeeId,
          financialYear: '2027-28',
          rating: 3,
        })
        .expect(201);
      const body = res.body as RatingBody;
      expect(body.status).toBe('SUBMITTED');

      const after = await prisma.notification.count({
        where: { userId: deptEmployeeId },
      });
      expect(after).toBe(before);
    });

    it('ADMIN/HR upsert publishes instantly as APPROVED and does notify', async () => {
      const before = await prisma.notification.count({
        where: { userId: outsideEmployeeId },
      });

      const res = await request(app.getHttpServer())
        .post('/performance-ratings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          employeeId: outsideEmployeeId,
          financialYear: '2027-28',
          rating: 4,
        })
        .expect(201);
      const body = res.body as RatingBody;
      expect(body.status).toBe('APPROVED');

      const after = await prisma.notification.count({
        where: { userId: outsideEmployeeId },
      });
      expect(after).toBe(before + 1);
    });

    it('MANAGER is forbidden from calling approve/reject', async () => {
      const rating = await prisma.performanceRating.findFirstOrThrow({
        where: { employeeId: deptEmployeeId, financialYear: '2027-28' },
      });
      await request(app.getHttpServer())
        .patch(`/performance-ratings/${rating.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(403);
    });

    it('HR/Admin approve() sets APPROVED, stamps approvedBy/approvedAt, and does notify', async () => {
      const rating = await prisma.performanceRating.findFirstOrThrow({
        where: { employeeId: deptEmployeeId, financialYear: '2027-28' },
      });
      expect(rating.status).toBe('SUBMITTED');

      const before = await prisma.notification.count({
        where: { userId: deptEmployeeId },
      });

      const res = await request(app.getHttpServer())
        .patch(`/performance-ratings/${rating.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ rating: 5 })
        .expect(200);
      const body = res.body as RatingBody;
      expect(body.status).toBe('APPROVED');
      expect(body.rating).toBe(5); // optional override applied

      const after = await prisma.notification.count({
        where: { userId: deptEmployeeId },
      });
      expect(after).toBe(before + 1);

      const updated = await prisma.performanceRating.findFirstOrThrow({
        where: { id: rating.id },
      });
      expect(updated.approvedById).toBeTruthy();
      expect(updated.approvedAt).toBeTruthy();
    });

    it('approve() on an already-approved row is rejected', async () => {
      const rating = await prisma.performanceRating.findFirstOrThrow({
        where: { employeeId: deptEmployeeId, financialYear: '2027-28' },
      });
      await request(app.getHttpServer())
        .patch(`/performance-ratings/${rating.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(400);
    });

    it('reject() sets REJECTED and does not notify', async () => {
      await request(app.getHttpServer())
        .post('/performance-ratings')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          employeeId: deptEmployeeId,
          financialYear: '2028-29',
          rating: 2,
        })
        .expect(201);
      const rating = await prisma.performanceRating.findFirstOrThrow({
        where: { employeeId: deptEmployeeId, financialYear: '2028-29' },
      });

      const before = await prisma.notification.count({
        where: { userId: deptEmployeeId },
      });

      const res = await request(app.getHttpServer())
        .patch(`/performance-ratings/${rating.id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Needs more evidence' })
        .expect(200);
      expect((res.body as RatingBody).status).toBe('REJECTED');

      const after = await prisma.notification.count({
        where: { userId: deptEmployeeId },
      });
      expect(after).toBe(before);
    });

    it('reject() on an already-rejected row is rejected', async () => {
      const rating = await prisma.performanceRating.findFirstOrThrow({
        where: { employeeId: deptEmployeeId, financialYear: '2028-29' },
      });
      await request(app.getHttpServer())
        .patch(`/performance-ratings/${rating.id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(400);
    });

    it('self-approval is blocked: an HR/Admin cannot approve/reject their own rating', async () => {
      await request(app.getHttpServer())
        .post('/performance-ratings')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          employeeId: hrEmployeeId,
          financialYear: '2027-28',
          rating: 3,
        })
        .expect(201);
      const rating = await prisma.performanceRating.findFirstOrThrow({
        where: { employeeId: hrEmployeeId, financialYear: '2027-28' },
      });

      await request(app.getHttpServer())
        .patch(`/performance-ratings/${rating.id}/approve`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({})
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/performance-ratings/${rating.id}/reject`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({})
        .expect(403);
    });
  });
});
