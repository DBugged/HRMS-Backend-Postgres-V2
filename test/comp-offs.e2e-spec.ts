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
interface CompOffBody {
  id: string;
  employeeId: string;
  status: string;
  daysEarned: number;
  daysAvailed: number;
  employee?: { id: string; name: string; employeeId: string };
}

const PASSWORD = 'TestPass123!';

describe('Comp-Offs (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let managerToken: string;
  let employeeToken: string;
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
      organizationName: 'Comp-Offs E2E Org',
      name: 'Founder',
      email: 'compoffs-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'compoffs-e2e-admin@example.test', password: PASSWORD });
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
        email: 'compoffs-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    const managerPassword = (
      managerCreate.body as { generatedPassword: string }
    ).generatedPassword;
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'compoffs-e2e-manager@example.test',
        password: managerPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Eng Employee',
        email: 'compoffs-e2e-emp@example.test',
        departmentId,
      });
    const empBody = empCreate.body as {
      employee: { id: string };
      generatedPassword: string;
    };
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'compoffs-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "comp_offs", "leave_balances", "leaves", "leave_types", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  const pastDate = (daysAgo = 2) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };

  let compOffId: string;

  it('EMPLOYEE earns a comp-off for a worked date', async () => {
    const res = await request(app.getHttpServer())
      .post('/comp-offs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ earnedForDate: pastDate(), reason: 'Worked the weekend' })
      .expect(201);
    const body = res.body as CompOffBody;
    expect(body.status).toBe('PENDING');
    expect(body.employeeId).toBe(employeeId);
    compOffId = body.id;
  });

  it('rejects a future earnedForDate', async () => {
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 5);
    await request(app.getHttpServer())
      .post('/comp-offs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ earnedForDate: future.toISOString().slice(0, 10) })
      .expect(400);
  });

  it('EMPLOYEE only sees their own comp-offs; MANAGER sees the whole department', async () => {
    const selfList = await request(app.getHttpServer())
      .get('/comp-offs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((selfList.body as { data: CompOffBody[] }).data).toHaveLength(1);

    const deptList = await request(app.getHttpServer())
      .get('/comp-offs')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const deptBody = (deptList.body as { data: CompOffBody[] }).data;
    expect(deptBody.some((c) => c.id === compOffId)).toBe(true);
    expect(deptBody.find((c) => c.id === compOffId)?.employee?.id).toBe(
      deptBody.find((c) => c.id === compOffId)?.employeeId,
    );
  });

  it('EMPLOYEE gets 403 reviewing a comp-off', async () => {
    await request(app.getHttpServer())
      .patch(`/comp-offs/${compOffId}/review`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ decision: 'APPROVED' })
      .expect(403);
  });

  it('MANAGER approves the comp-off', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/comp-offs/${compOffId}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);
    expect((res.body as CompOffBody).status).toBe('APPROVED');
  });

  it('rejects reviewing an already-reviewed comp-off', async () => {
    await request(app.getHttpServer())
      .patch(`/comp-offs/${compOffId}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'REJECTED' })
      .expect(400);
  });

  it('GET /comp-offs/balance reflects the approved, unconsumed comp-off', async () => {
    const res = await request(app.getHttpServer())
      .get('/comp-offs/balance')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((res.body as { available: number }).available).toBe(1);
  });

  it('MANAGER earns a comp-off on behalf of the employee', async () => {
    // Distinct date from the earlier employee-earned comp-off (already
    // APPROVED for pastDate()) — same employee + same date would now be
    // rejected as a duplicate claim (see suite below).
    const res = await request(app.getHttpServer())
      .post('/comp-offs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        earnedForDate: pastDate(3),
        employeeId,
        reason: 'Manager-raised',
      })
      .expect(201);
    expect((res.body as CompOffBody).employeeId).toBe(employeeId);
  });

  // Duplicate-claim guard — earn() previously had no check at all for
  // (employeeId, earnedForDate), so an employee (or a manager on their
  // behalf) could submit unlimited comp-off earn requests for the exact
  // same worked date. This suite verifies the new ConflictException guard,
  // and that it deliberately excludes REJECTED claims so a legitimate
  // resubmission after rejection still works.
  describe('duplicate-claim guard', () => {
    const dupDate = () => pastDate(10);
    let firstDupCompOffId: string;

    it('a second earn request for the same employee+date is rejected with a clean 409', async () => {
      const first = await request(app.getHttpServer())
        .post('/comp-offs')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ earnedForDate: dupDate(), reason: 'Worked Saturday' })
        .expect(201);
      expect((first.body as CompOffBody).status).toBe('PENDING');
      firstDupCompOffId = (first.body as CompOffBody).id;

      const second = await request(app.getHttpServer())
        .post('/comp-offs')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ earnedForDate: dupDate(), reason: 'Worked Saturday again?' })
        .expect(409);
      expect((second.body as { message: string }).message).toMatch(
        /already exists/i,
      );
    });

    it('resubmitting for the same date succeeds once the earlier claim was REJECTED', async () => {
      await request(app.getHttpServer())
        .patch(`/comp-offs/${firstDupCompOffId}/review`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ decision: 'REJECTED' })
        .expect(200);

      const resubmit = await request(app.getHttpServer())
        .post('/comp-offs')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ earnedForDate: dupDate(), reason: 'Corrected resubmission' })
        .expect(201);
      expect((resubmit.body as CompOffBody).status).toBe('PENDING');
    });
  });

  // Approval-delegation wiring (same isActiveDelegate pattern as
  // LeavesService.review(), now also applied to comp-off review via
  // assertManagerScopeOrDelegate) — a delegate in a *different* department
  // than the employee should still be able to review once an active
  // delegation names them as the employee's manager's stand-in.
  describe('approval-delegation wiring', () => {
    let manager2Token: string;
    let manager2Id: string;
    let managerId: string;
    let delegatedEmployeeToken: string;

    beforeAll(async () => {
      const managerMe = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      managerId = (managerMe.body as { id: string }).id;

      const dept2 = await request(app.getHttpServer())
        .post('/departments')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Sales', code: 'SALES-DEL' });
      const dept2Id = (dept2.body as { id: string }).id;

      const m2Create = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Sales Manager',
          email: 'compoffs-e2e-manager2@example.test',
          role: 'MANAGER',
          departmentId: dept2Id,
        });
      manager2Id = (m2Create.body as { employee: { id: string } }).employee.id;
      const m2Login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'compoffs-e2e-manager2@example.test',
          password: (m2Create.body as { generatedPassword: string })
            .generatedPassword,
        });
      manager2Token = (m2Login.body as AuthBody).accessToken;

      // A fresh employee explicitly reporting to `managerId` (in
      // Engineering), distinct from `employeeId` used above, so this
      // sub-suite's delegation checks are self-contained.
      const emp2Create = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Delegation Test Employee',
          email: 'compoffs-e2e-emp2@example.test',
          reportingManagerId: managerId,
        });
      const emp2Login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'compoffs-e2e-emp2@example.test',
          password: (emp2Create.body as { generatedPassword: string })
            .generatedPassword,
        });
      delegatedEmployeeToken = (emp2Login.body as AuthBody).accessToken;
    });

    it("without a delegation, manager2 (different department, not the direct manager) gets 403 reviewing the employee's comp-off", async () => {
      const earn = await request(app.getHttpServer())
        .post('/comp-offs')
        .set('Authorization', `Bearer ${delegatedEmployeeToken}`)
        .send({ earnedForDate: pastDate(), reason: 'Weekend work' })
        .expect(201);
      const coId = (earn.body as CompOffBody).id;

      await request(app.getHttpServer())
        .patch(`/comp-offs/${coId}/review`)
        .set('Authorization', `Bearer ${manager2Token}`)
        .send({ decision: 'APPROVED' })
        .expect(403);
    });

    it("with an active ApprovalDelegation from the employee's manager to manager2, manager2 CAN review the comp-off", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

      await request(app.getHttpServer())
        .post('/delegations')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          delegate: manager2Id,
          fromDate: today,
          toDate: tomorrow.toISOString().slice(0, 10),
        })
        .expect(201);

      // Distinct date from the earlier delegatedEmployeeToken earn above
      // (same employee) — same employee + same date would now be rejected
      // as a duplicate claim.
      const earn = await request(app.getHttpServer())
        .post('/comp-offs')
        .set('Authorization', `Bearer ${delegatedEmployeeToken}`)
        .send({ earnedForDate: pastDate(4), reason: 'Weekend work again' })
        .expect(201);
      const coId = (earn.body as CompOffBody).id;

      const review = await request(app.getHttpServer())
        .patch(`/comp-offs/${coId}/review`)
        .set('Authorization', `Bearer ${manager2Token}`)
        .send({ decision: 'APPROVED' })
        .expect(200);
      expect((review.body as CompOffBody).status).toBe('APPROVED');
    });
  });
});
