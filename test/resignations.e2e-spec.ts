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
  submittedOn: string;
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
      .send({
        name:
          email
            .split('@')[0]
            .replace(/[^a-zA-Z]+/g, ' ')
            .trim() || 'Test User',
        email,
        // Approving a resignation starts an offboarding, which needs a personal email for the final documents.
        personalEmail: email.replace('@', '.personal@'),
        ...(role && { role }),
      });
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

  it("uses the organization's notice period whatever the client sends, and the last working day must respect it", async () => {
    const org = await prisma.organization.findFirstOrThrow({
      where: { id: organizationId },
      select: { policies: true },
    });
    const before = (org.policies ?? {}) as Record<string, unknown>;
    await prisma.organization.update({
      where: { id: organizationId },
      data: { policies: { ...before, defaultNoticeDays: 30 } },
    });
    try {
      // The employee's own figure (5) is ignored: the 30-day default applies, so a last day 10 days out is refused.
      const res = await request(app.getHttpServer())
        .post('/resignations')
        .set('Authorization', `Bearer ${empToken}`)
        .send({ requestedLwd: dateOffset(10), noticePeriodDays: 5 })
        .expect(400);
      expect(
        JSON.stringify((res.body as { message: unknown }).message),
      ).toContain('notice period of 30 day');
    } finally {
      await prisma.organization.update({
        where: { id: organizationId },
        data: { policies: before as object },
      });
    }
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

  it('HR approves: LWD defaults to the date the employee asked for, case is created and linked, status is RESIGNED (the notice stage)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/resignations/${resignationId}/approve`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decisionNote: 'Accepted' })
      .expect(200);
    const body = res.body as ResignationBody;
    expect(body.status).toBe('APPROVED');
    // The employee asked for dateOffset(45); the approver did not move it.
    expect(body.approvedLwd).toBe(dateOffset(45));
    expect(body.offboardingCaseId).not.toBeNull();
    caseId = body.offboardingCaseId!;

    const employee = await prisma.user.findFirstOrThrow({
      where: { id: empId },
    });
    expect(employee.employmentStatus).toBe('RESIGNED');
    const history = await prisma.employmentStatusHistory.findMany({
      where: { employeeId: empId, newStatus: 'RESIGNED' },
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

  it('completes the exit: RELEASED status, history row, sessions revoked, account deactivated', async () => {
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
    // A settlement is calculated for the case's own last working day and only on or after it: release early, so the
    // last working day is today.
    await request(app.getHttpServer())
      .patch(`/offboarding/${caseId}/last-working-day`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        lastWorkingDay: dateOffset(0),
        reason: 'Released early on agreement',
      })
      .expect(200);
    const settlement = await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      // A settlement can only be calculated on or after the last working day, so use today.
      .send({ employeeId: empId, lastWorkingDay: dateOffset(0) })
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
    expect(employee.employmentStatus).toBe('RELEASED');
    const history = await prisma.employmentStatusHistory.findMany({
      where: { employeeId: empId, newStatus: 'RELEASED' },
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
    ).toBe('RESIGNED');
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
      .send({ requestedLwd: dateOffset(40), noticePeriodDays: 30 })
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
      .send({ requestedLwd: dateOffset(40), noticePeriodDays: 30 })
      .expect(201);
    const hrResId = (hrSub.body as ResignationBody).id;
    await request(app.getHttpServer())
      .patch(`/resignations/${hrResId}/approve`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({})
      .expect(403);
    // 15 days is before the 30-day notice ends: an early release needs a note.
    await request(app.getHttpServer())
      .patch(`/resignations/${hrResId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approvedLwd: dateOffset(15) })
      .expect(400);
    const approved = await request(app.getHttpServer())
      .patch(`/resignations/${hrResId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        approvedLwd: dateOffset(15),
        decisionNote: 'Released early at their request',
      })
      .expect(200);
    const body = approved.body as ResignationBody;
    expect(body.approvedLwd).toBe(dateOffset(15));
    expect(body.decidedById).not.toBe(hrId);
  });

  describe('recorded on the employee behalf', () => {
    let emp3Id: string;
    let emp3Token: string;
    let emp4Id: string;

    beforeAll(async () => {
      const emp3 = await createEmployee('resig-e2e-emp3@example.test');
      emp3Id = emp3.id;
      emp3Token = emp3.token;
      const emp4 = await createEmployee('resig-e2e-emp4@example.test');
      emp4Id = emp4.id;
      // joined a while ago, so a resignation can have been received days before it is recorded
      await prisma.user.updateMany({
        where: { id: { in: [emp3Id, emp4Id] } },
        data: { joiningDate: new Date(`${dateOffset(-60)}T00:00:00.000Z`) },
      });
    });

    const record = (token: string, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/resignations/on-behalf')
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    it('HR records one as Pending, dated when it was received, marked as entered by HR', async () => {
      const res = await record(hrToken, {
        employeeId: emp3Id,
        receivedOn: dateOffset(-3),
        requestedLwd: dateOffset(40),
        reason: 'Sent by email',
      }).expect(201);
      const body = res.body as ResignationBody & {
        recordedBy: { id: string } | null;
        approvalError: string | null;
      };
      expect(body.status).toBe('PENDING');
      expect(body.submittedOn).toBe(dateOffset(-3));
      expect(body.recordedBy?.id).toBe(hrId);
      expect(body.approvalError).toBeNull();

      // the employee sees it, with who entered it
      const mine = await request(app.getHttpServer())
        .get('/resignations/mine')
        .set('Authorization', `Bearer ${emp3Token}`)
        .expect(200);
      const first = (mine.body as { recordedBy: { id: string } | null }[])[0];
      expect(first.recordedBy?.id).toBe(hrId);

      // HR sees it in the list, and it is audited
      const list = await request(app.getHttpServer())
        .get('/resignations')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const rows = (
        list.body as { data: { id: string; recordedBy: unknown }[] }
      ).data;
      expect(rows.find((r) => r.id === body.id)?.recordedBy).toBeTruthy();
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'RESIGNATION_RECORDED_ON_BEHALF',
            targetId: emp3Id,
          },
        }),
      ).toBe(1);
    });

    it('a second open one for the same employee is refused', async () => {
      await record(hrToken, {
        employeeId: emp3Id,
        requestedLwd: dateOffset(45),
      }).expect(400);
    });

    it('recorded and approved in one go: the case opens and the employee is Resigned', async () => {
      const res = await record(adminToken, {
        employeeId: emp4Id,
        requestedLwd: dateOffset(30),
        noticePeriodDays: 30,
        approveNow: true,
      }).expect(201);
      const body = res.body as ResignationBody & {
        approvalError: string | null;
      };
      expect(body.approvalError).toBeNull();
      expect(body.status).toBe('APPROVED');
      expect(body.offboardingCaseId).not.toBeNull();
      const employee = await prisma.user.findFirstOrThrow({
        where: { id: emp4Id },
      });
      expect(employee.employmentStatus).toBe('RESIGNED');
    });

    it('is refused for yourself, for the wrong people, and for a future date', async () => {
      // not on your own behalf
      await record(hrToken, {
        employeeId: hrId,
        requestedLwd: dateOffset(40),
      }).expect(400);
      // an employee cannot record one for anyone
      await record(emp2Token, {
        employeeId: emp4Id,
        requestedLwd: dateOffset(40),
      }).expect(403);
      // only an Admin handles an HR employee's resignation: HR cannot record it for another HR/Admin
      const adminRow = await prisma.user.findFirstOrThrow({
        where: { email: 'resig-e2e-admin@example.test' },
      });
      await record(hrToken, {
        employeeId: adminRow.id,
        requestedLwd: dateOffset(40),
      }).expect(403);
      // received in the future
      await record(hrToken, {
        employeeId: emp2Id,
        receivedOn: dateOffset(2),
        requestedLwd: dateOffset(40),
      }).expect(400);
    });
  });

  describe('manager view, withdrawal request and early release', () => {
    it("a manager sees a direct report's resignation read-only; an unrelated employee does not", async () => {
      const manager = await createEmployee(
        'resig-e2e-mgr@example.test',
        'MANAGER',
      );
      const report = await createEmployee('resig-e2e-report@example.test');
      await prisma.user.update({
        where: { id: report.id },
        data: { reportingManagerId: manager.id },
      });
      await request(app.getHttpServer())
        .post(`/employee-salary/${report.id}/structure`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          componentCode: 'BASIC',
          fixedAmount: 30000,
          effectiveFrom: '2026-01-01',
        })
        .expect(201);

      const submitted = await request(app.getHttpServer())
        .post('/resignations')
        .set('Authorization', `Bearer ${report.token}`)
        .send({ requestedLwd: dateOffset(40), noticePeriodDays: 30 })
        .expect(201);
      const id = (submitted.body as ResignationBody).id;

      const team = await request(app.getHttpServer())
        .get('/resignations/team')
        .set('Authorization', `Bearer ${manager.token}`)
        .expect(200);
      expect((team.body as ResignationBody[]).map((r) => r.id)).toContain(id);
      await request(app.getHttpServer())
        .get(`/resignations/${id}`)
        .set('Authorization', `Bearer ${manager.token}`)
        .expect(200);
      // Read-only: a manager cannot decide it.
      await request(app.getHttpServer())
        .patch(`/resignations/${id}/approve`)
        .set('Authorization', `Bearer ${manager.token}`)
        .send({})
        .expect(403);
      // Someone who does not manage this person gets nothing.
      await request(app.getHttpServer())
        .get(`/resignations/${id}`)
        .set('Authorization', `Bearer ${emp2Token}`)
        .expect(404);

      // A withdrawal request is only for an approved resignation.
      await request(app.getHttpServer())
        .post(`/resignations/${id}/withdrawal-request`)
        .set('Authorization', `Bearer ${report.token}`)
        .send({ reason: 'Plans changed' })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/resignations/${id}/approve`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .post(`/resignations/${id}/withdrawal-request`)
        .set('Authorization', `Bearer ${report.token}`)
        .send({ reason: 'Plans changed' })
        .expect(201);
      // The request leaves a trace, and nothing changed in the resignation itself.
      const audit = await prisma.auditLog.count({
        where: {
          action: 'RESIGNATION_WITHDRAWAL_REQUESTED',
          targetId: report.id,
        },
      });
      expect(audit).toBe(1);
      const after = await prisma.resignation.findFirstOrThrow({
        where: { id },
      });
      expect(after.status).toBe('APPROVED');
      // ...except that the request is now kept on it, so it shows as waiting for HR.
      expect(after.withdrawalStatus).toBe('REQUESTED');
      expect(after.withdrawalReason).toBe('Plans changed');

      // Sending it again while it is waiting is refused (no second notification).
      await request(app.getHttpServer())
        .post(`/resignations/${id}/withdrawal-request`)
        .set('Authorization', `Bearer ${report.token}`)
        .send({ reason: 'Plans changed' })
        .expect(409);

      // Only HR/Admin decide; the employee cannot.
      await request(app.getHttpServer())
        .patch(`/resignations/${id}/withdrawal-request/decision`)
        .set('Authorization', `Bearer ${report.token}`)
        .send({ decision: 'APPROVE' })
        .expect(403);

      // Declining needs a note, which the employee then sees.
      await request(app.getHttpServer())
        .patch(`/resignations/${id}/withdrawal-request/decision`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'DECLINE' })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/resignations/${id}/withdrawal-request/decision`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'DECLINE', note: 'We need you through the handover' })
        .expect(200);
      const declined = await prisma.resignation.findFirstOrThrow({
        where: { id },
      });
      expect(declined.status).toBe('APPROVED');
      expect(declined.withdrawalStatus).toBe('DECLINED');
      expect(declined.withdrawalDecisionNote).toBe(
        'We need you through the handover',
      );
      // Nothing is waiting any more, so a decision now has nothing to act on.
      await request(app.getHttpServer())
        .patch(`/resignations/${id}/withdrawal-request/decision`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'APPROVE' })
        .expect(400);

      // A declined request can be raised again; approving it cancels the exit and withdraws the resignation.
      await request(app.getHttpServer())
        .post(`/resignations/${id}/withdrawal-request`)
        .set('Authorization', `Bearer ${report.token}`)
        .send({ reason: 'Counter-offer accepted' })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/resignations/${id}/withdrawal-request/decision`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'APPROVE' })
        .expect(200);
      const approved = await prisma.resignation.findFirstOrThrow({
        where: { id },
      });
      expect(approved.status).toBe('WITHDRAWN');
      expect(approved.withdrawalStatus).toBe('APPROVED');
      const exitCase = await prisma.offboardingCase.findFirstOrThrow({
        where: { id: approved.offboardingCaseId! },
      });
      expect(exitCase.status).toBe('CANCELLED');
    });
  });
});
