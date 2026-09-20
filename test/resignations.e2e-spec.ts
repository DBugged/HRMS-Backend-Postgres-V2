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
interface ResignationBody {
  id: string;
  status: string;
  approvedLwd: string | null;
  noticePeriodDays: number | null;
  offboardingCaseId: string | null;
  decidedById: string | null;
}
interface CaseBody {
  id: string;
  status: string;
  lastWorkingDay: string;
  exitStatus: string;
  openAssets: { id: string; assetName: string }[];
}

const PASSWORD = 'TestPass123!';

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

describe('Resignations & exit lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let organizationId: string;

  let adminToken: string;
  let hrToken: string;
  let hrId: string;
  let empToken: string;
  let empId: string;
  let emp2Token: string;
  let emp2Id: string;

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
      organizationName: 'Resignations E2E Org',
      name: 'Founder',
      email: 'resig-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'resig-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'resig-e2e-admin@example.test' },
      })
    ).organizationId;

    const hr = await createEmployee('resig-e2e-hr@example.test', 'HR');
    hrId = hr.id;
    hrToken = hr.token;
    const emp = await createEmployee('resig-e2e-emp@example.test');
    empId = emp.id;
    empToken = emp.token;
    const emp2 = await createEmployee('resig-e2e-emp2@example.test');
    emp2Id = emp2.id;
    emp2Token = emp2.token;

    for (const id of [empId, emp2Id]) {
      await request(app.getHttpServer())
        .post(`/employee-salary/${id}/structure`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          componentCode: 'BASIC',
          fixedAmount: 30000,
          effectiveFrom: '2026-01-01',
        })
        .expect(201);
    }
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "resignations", "offboarding_cases", "settlements", "payroll_runs", "employee_assets", "employment_status_history", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  let resignationId: string;
  let caseId: string;

  it('rejects an invalid or past requestedLwd', async () => {
    await request(app.getHttpServer())
      .post('/resignations')
      .set('Authorization', `Bearer ${empToken}`)
      .send({ requestedLwd: '2020-01-01' })
      .expect(400);
  });

  it('employee submits a resignation; a second open one is refused', async () => {
    const res = await request(app.getHttpServer())
      .post('/resignations')
      .set('Authorization', `Bearer ${empToken}`)
      .send({
        requestedLwd: dateOffset(45),
        reason: 'Relocating',
        noticePeriodDays: 30,
      })
      .expect(201);
    const body = res.body as ResignationBody;
    resignationId = body.id;
    expect(body.status).toBe('PENDING');
    await request(app.getHttpServer())
      .post('/resignations')
      .set('Authorization', `Bearer ${empToken}`)
      .send({ requestedLwd: dateOffset(50) })
      .expect(400);

    const timeline = await prisma.employeeTimeline.findMany({
      where: { employeeId: empId, eventKey: 'RESIGNATION_SUBMITTED' },
    });
    expect(timeline).toHaveLength(1);
  });

  it('another employee cannot read it, and cannot decide it', async () => {
    await request(app.getHttpServer())
      .get(`/resignations/${resignationId}`)
      .set('Authorization', `Bearer ${emp2Token}`)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/resignations/${resignationId}/approve`)
      .set('Authorization', `Bearer ${emp2Token}`)
      .send({})
      .expect(403);
  });

  it('HR lists it; the employee sees it in /mine', async () => {
    const list = await request(app.getHttpServer())
      .get('/resignations?status=PENDING')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    expect((list.body as { data: unknown[] }).data).toHaveLength(1);
    const mine = await request(app.getHttpServer())
      .get('/resignations/mine')
      .set('Authorization', `Bearer ${empToken}`)
      .expect(200);
    expect(mine.body as unknown[]).toHaveLength(1);
  });

  it('withdrawing, then resubmitting works; a withdrawn one cannot be approved', async () => {
    await request(app.getHttpServer())
      .patch(`/resignations/${resignationId}/withdraw`)
      .set('Authorization', `Bearer ${empToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/resignations/${resignationId}/approve`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({})
      .expect(400);
    const res = await request(app.getHttpServer())
      .post('/resignations')
      .set('Authorization', `Bearer ${empToken}`)
      .send({
        requestedLwd: dateOffset(45),
        reason: 'Relocating',
        noticePeriodDays: 30,
      })
      .expect(201);
    resignationId = (res.body as ResignationBody).id;
  });

  it('HR approves: LWD defaults to submittedOn + notice, case is created and linked, status is NOTICE_PERIOD', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/resignations/${resignationId}/approve`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decisionNote: 'Accepted' })
      .expect(200);
    const body = res.body as ResignationBody;
    expect(body.status).toBe('APPROVED');
    expect(body.approvedLwd).toBe(dateOffset(30));
    expect(body.offboardingCaseId).not.toBeNull();
    caseId = body.offboardingCaseId!;

    const employee = await prisma.user.findFirstOrThrow({
      where: { id: empId },
    });
    expect(employee.employmentStatus).toBe('NOTICE_PERIOD');
    const history = await prisma.employmentStatusHistory.findMany({
      where: { employeeId: empId, newStatus: 'NOTICE_PERIOD' },
    });
    expect(history).toHaveLength(1);
    const events = await prisma.employeeTimeline.findMany({
      where: { employeeId: empId },
    });
    expect(events.map((e) => e.eventKey)).toEqual(
      expect.arrayContaining([
        'RESIGNATION_SUBMITTED',
        'RESIGNATION_APPROVED',
        'NOTICE_PERIOD_STARTED',
      ]),
    );
    // Re-deciding is refused.
    await request(app.getHttpServer())
      .patch(`/resignations/${resignationId}/reject`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({})
      .expect(400);
  });

  it('an employee already in an open exit cannot resign again', async () => {
    await request(app.getHttpServer())
      .post('/resignations')
      .set('Authorization', `Bearer ${empToken}`)
      .send({ requestedLwd: dateOffset(60) })
      .expect(400);
  });

  it('blocks assetsReturned while assets are still allocated, lists them, and allows an explicit override', async () => {
    await prisma.employeeAsset.create({
      data: {
        organizationId,
        employeeId: empId,
        assetType: 'Laptop',
        assetName: 'MacBook',
        assetTag: 'LT-1',
        allocatedDate: '2026-01-01',
        allocatedById: hrId,
      },
    });
    const blocked = await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/checklist`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ assetsReturned: true })
      .expect(400);
    expect((blocked.body as { message: string }).message).toContain('MacBook');

    const view = await request(app.getHttpServer())
      .get(`/offboarding/${caseId}`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    expect((view.body as CaseBody).openAssets).toHaveLength(1);

    // Returning the asset unblocks it without an override.
    await prisma.employeeAsset.updateMany({
      where: { employeeId: empId },
      data: { status: 'RETURNED', returnedDate: '2026-02-01' },
    });
    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/checklist`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ assetsReturned: true, accessRevoked: true })
      .expect(200);
  });

  it('completes the exit: RESIGNED status, history row, sessions revoked, account deactivated', async () => {
    await prisma.refreshToken.create({
      data: {
        userId: empId,
        organizationId,
        tokenHash: `resig-e2e-${Date.now()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/exit-interview`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ reasonForLeaving: 'Career Growth', overallExperience: 4 })
      .expect(200);
    const settlement = await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeId: empId, lastWorkingDay: dateOffset(30) })
      .expect(201);
    const settlementId = (settlement.body as { id: string }).id;
    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/settlement`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ settlementId })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/settlements/${settlementId}/process`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    // Still active after settlement processing — only complete() deactivates.
    expect(
      (await prisma.user.findFirstOrThrow({ where: { id: empId } })).isActive,
    ).toBe(true);

    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/complete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);

    const employee = await prisma.user.findFirstOrThrow({
      where: { id: empId },
    });
    expect(employee.isActive).toBe(false);
    expect(employee.employmentStatus).toBe('RESIGNED');
    const history = await prisma.employmentStatusHistory.findMany({
      where: { employeeId: empId, newStatus: 'RESIGNED' },
    });
    expect(history).toHaveLength(1);
    expect(
      await prisma.refreshToken.count({
        where: { userId: empId, revokedAt: null },
      }),
    ).toBe(0);
  });

  it('cancelling an exit restores the previous employment status', async () => {
    await prisma.user.updateMany({
      where: { id: emp2Id },
      data: { employmentStatus: 'CONFIRMED' },
    });
    const res = await request(app.getHttpServer())
      .post('/offboarding')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ employeeId: emp2Id, lastWorkingDay: dateOffset(20) })
      .expect(201);
    const id = (res.body as CaseBody).id;
    expect(
      (await prisma.user.findFirstOrThrow({ where: { id: emp2Id } }))
        .employmentStatus,
    ).toBe('NOTICE_PERIOD');
    await request(app.getHttpServer())
      .patch(`/offboarding/${id}/cancel`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    expect(
      (await prisma.user.findFirstOrThrow({ where: { id: emp2Id } }))
        .employmentStatus,
    ).toBe('CONFIRMED');
  });

  it('reject path, own-request rule and HR-tier rule', async () => {
    // employee 2 resigns and HR rejects.
    const sub = await request(app.getHttpServer())
      .post('/resignations')
      .set('Authorization', `Bearer ${emp2Token}`)
      .send({ requestedLwd: dateOffset(40) })
      .expect(201);
    const rejected = await request(app.getHttpServer())
      .patch(`/resignations/${(sub.body as ResignationBody).id}/reject`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decisionNote: 'Please stay' })
      .expect(200);
    expect((rejected.body as ResignationBody).status).toBe('REJECTED');

    // HR resigns: cannot decide own, another HR/ADMIN rules — only ADMIN may decide.
    const hrSub = await request(app.getHttpServer())
      .post('/resignations')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ requestedLwd: dateOffset(40), noticePeriodDays: 10 })
      .expect(201);
    const hrResId = (hrSub.body as ResignationBody).id;
    await request(app.getHttpServer())
      .patch(`/resignations/${hrResId}/approve`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({})
      .expect(403);
    const approved = await request(app.getHttpServer())
      .patch(`/resignations/${hrResId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approvedLwd: dateOffset(15) })
      .expect(200);
    const body = approved.body as ResignationBody;
    expect(body.approvedLwd).toBe(dateOffset(15));
    expect(body.decidedById).not.toBe(hrId);
  });
});
