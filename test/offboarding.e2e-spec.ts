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
interface OffboardingBody {
  id: string;
  status: string;
  employeeId: string;
  assetsReturned: boolean;
  accessRevoked: boolean;
  exitInterviewDone: boolean;
  settlementId: string | null;
  completedById: string | null;
  employee?: { id: string; name: string; employeeId: string };
  settlement?: { id: string } | null;
}
interface SettlementBody {
  id: string;
  employeeId: string;
}
interface OffboardingListBody {
  data: OffboardingBody[];
  total: number;
  page: number;
  limit: number;
}

const PASSWORD = 'TestPass123!';

describe('Offboarding (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
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
      organizationName: 'Offboarding E2E Org',
      name: 'Founder',
      email: 'offb-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'offb-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'offb-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'offb-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Departing Employee', email: 'offb-e2e-emp@example.test' });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'offb-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const otherCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Other Employee', email: 'offb-e2e-other@example.test' });
    otherEmployeeId = (otherCreate.body as EmployeeCreateBody).employee.id;

    // BASIC is auto-seeded on every new org (see LeaveTypesService/
    // SalaryComponentsService.seedDefaults) — HRA (also seeded, PERCENTAGE
    // of BASIC) auto-applies to every employee and its formula fails to
    // resolve unless BASIC itself was opted into via an override, which
    // the settlement calc below depends on transitively.
    for (const id of [employeeId, otherEmployeeId]) {
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
      'TRUNCATE TABLE "offboarding_cases", "settlements", "payroll_runs", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403 on every offboarding endpoint', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/offboarding')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
    await request(server)
      .post('/offboarding')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ employeeId, lastWorkingDay: '2026-06-30' })
      .expect(403);
  });

  let caseId: string;

  it('ADMIN initiates an offboarding case', async () => {
    const res = await request(app.getHttpServer())
      .post('/offboarding')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        lastWorkingDay: '2026-06-30',
        reason: 'Better Opportunity',
      })
      .expect(201);
    const body = res.body as OffboardingBody;
    caseId = body.id;
    expect(body.status).toBe('INITIATED');
    expect(body.employeeId).toBe(employeeId);
  });

  it('rejects initiating a second case while one is already open for the same employee', async () => {
    await request(app.getHttpServer())
      .post('/offboarding')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ employeeId, lastWorkingDay: '2026-07-15' })
      .expect(400);
  });

  it('404s for a non-existent case id', async () => {
    await request(app.getHttpServer())
      .get('/offboarding/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('updating the checklist moves INITIATED -> IN_PROGRESS', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/checklist`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ assetsReturned: true })
      .expect(200);
    const body = res.body as OffboardingBody;
    expect(body.assetsReturned).toBe(true);
    expect(body.status).toBe('IN_PROGRESS');
  });

  it('complete is rejected while checklist/exit-interview/settlement are outstanding', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/complete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    const message = (res.body as { message: string }).message;
    expect(message).toContain('accessRevoked');
    expect(message).toContain('exitInterviewDone');
    expect(message).toContain('settlement');
  });

  it('flips accessRevoked too', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/checklist`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ accessRevoked: true })
      .expect(200);
    expect((res.body as OffboardingBody).accessRevoked).toBe(true);
  });

  it('rejects an invalid reasonForLeaving on the exit interview', async () => {
    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/exit-interview`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonForLeaving: 'Not A Real Reason', overallExperience: 4 })
      .expect(400);
  });

  it('submits the exit interview, marking exitInterviewDone', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/exit-interview`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        reasonForLeaving: 'Career Growth',
        overallExperience: 5,
        wouldRecommend: true,
        likedMost: 'The team',
      })
      .expect(200);
    expect((res.body as OffboardingBody).exitInterviewDone).toBe(true);
  });

  it('rejects linking a settlement that belongs to a different employee', async () => {
    const otherSettlement = await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeId: otherEmployeeId, lastWorkingDay: '2026-06-30' })
      .expect(201);
    const otherSettlementId = (otherSettlement.body as SettlementBody).id;

    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/settlement`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ settlementId: otherSettlementId })
      .expect(400);
  });

  let settlementId: string;

  it('links the correct settlement', async () => {
    const settlement = await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeId, lastWorkingDay: '2026-06-30' })
      .expect(201);
    settlementId = (settlement.body as SettlementBody).id;

    const res = await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/settlement`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ settlementId })
      .expect(200);
    expect((res.body as OffboardingBody).settlementId).toBe(settlementId);
  });

  it('complete is rejected while the linked settlement is still a DRAFT', async () => {
    // A linked-but-unprocessed settlement must not be enough to let the
    // exit finalize — completing the case deactivates the account, and an
    // employee should never be relieved with their final payout still
    // sitting unprocessed. See OffboardingService.complete()'s DRAFT check.
    const res = await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/complete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect((res.body as { message: string }).message).toContain('DRAFT');
  });

  it('completes the case: deactivates the employee and stamps completedBy', async () => {
    await request(app.getHttpServer())
      .post(`/settlements/${settlementId}/process`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/complete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as OffboardingBody;
    expect(body.status).toBe('COMPLETED');
    expect(body.completedById).not.toBeNull();

    const employee = await prisma.user.findFirstOrThrow({
      where: { id: employeeId },
    });
    expect(employee.isActive).toBe(false);
  });

  it('a closed case rejects further checklist/complete updates', async () => {
    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/checklist`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assetsReturned: false })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/complete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('a completed case cannot be cancelled', async () => {
    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('a new open case for a different employee can be cancelled', async () => {
    const initiate = await request(app.getHttpServer())
      .post('/offboarding')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeId: otherEmployeeId, lastWorkingDay: '2026-08-01' })
      .expect(201);
    const otherCaseId = (initiate.body as OffboardingBody).id;

    const res = await request(app.getHttpServer())
      .patch(`/offboarding/${otherCaseId}/cancel`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    expect((res.body as OffboardingBody).status).toBe('CANCELLED');
  });

  it('ADMIN sees every case in the list', async () => {
    const res = await request(app.getHttpServer())
      .get('/offboarding')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const cases = (res.body as OffboardingListBody).data;
    expect(cases.some((c) => c.id === caseId)).toBe(true);
    expect(cases.length).toBeGreaterThanOrEqual(2);
  });

  it('list and detail responses include the employee and settlement relations', async () => {
    const listRes = await request(app.getHttpServer())
      .get('/offboarding')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const found = (listRes.body as OffboardingListBody).data.find(
      (c) => c.id === caseId,
    );
    expect(found?.employee?.id).toBe(employeeId);
    expect(found?.settlement?.id).toBe(settlementId);

    const detailRes = await request(app.getHttpServer())
      .get(`/offboarding/${caseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const detail = detailRes.body as OffboardingBody;
    expect(detail.employee?.id).toBe(employeeId);
    expect(detail.settlement?.id).toBe(settlementId);
  });
});
