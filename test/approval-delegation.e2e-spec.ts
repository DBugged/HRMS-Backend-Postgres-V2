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
interface DelegationBody {
  id: string;
  delegatorId: string;
  delegateId: string;
  isActive: boolean;
}

const PASSWORD = 'TestPass123!';

function offsetDate(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Approval Delegation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let manager1Token: string;
  let manager1Id: string;
  let manager2Token: string;
  let manager2Id: string;
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
      organizationName: 'Delegation E2E Org',
      name: 'Founder',
      email: 'del-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'del-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'del-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'del-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const m1Create = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Manager One',
        email: 'del-e2e-m1@example.test',
        role: 'MANAGER',
      });
    manager1Id = (m1Create.body as EmployeeCreateBody).employee.id;
    const m1Login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'del-e2e-m1@example.test',
        password: (m1Create.body as EmployeeCreateBody).generatedPassword,
      });
    manager1Token = (m1Login.body as AuthBody).accessToken;

    const m2Create = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Manager Two',
        email: 'del-e2e-m2@example.test',
        role: 'MANAGER',
      });
    manager2Id = (m2Create.body as EmployeeCreateBody).employee.id;
    const m2Login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'del-e2e-m2@example.test',
        password: (m2Create.body as EmployeeCreateBody).generatedPassword,
      });
    manager2Token = (m2Login.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'del-e2e-emp@example.test',
        reportingManagerId: manager1Id,
      });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'del-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Earned Leave',
        code: 'EL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 24,
        prorateOnJoining: false,
      })
      .expect(201);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "approval_delegations", "leaves", "leave_balances", "leave_types", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('rejects self-delegation', async () => {
    await request(app.getHttpServer())
      .post('/delegations')
      .set('Authorization', `Bearer ${manager1Token}`)
      .send({
        delegate: manager1Id,
        fromDate: offsetDate(0),
        toDate: offsetDate(5),
      })
      .expect(400);
  });

  it('rejects toDate before fromDate', async () => {
    await request(app.getHttpServer())
      .post('/delegations')
      .set('Authorization', `Bearer ${manager1Token}`)
      .send({
        delegate: manager2Id,
        fromDate: offsetDate(5),
        toDate: offsetDate(0),
      })
      .expect(400);
  });

  it('rejects a delegate who is not a manager/HR/admin', async () => {
    await request(app.getHttpServer())
      .post('/delegations')
      .set('Authorization', `Bearer ${manager1Token}`)
      .send({
        delegate: employeeId,
        fromDate: offsetDate(0),
        toDate: offsetDate(5),
      })
      .expect(400);
  });

  it("without any delegation, manager2 (not the direct manager) gets 403 reviewing the employee's leave", async () => {
    const leaveType = await prisma.leaveType.findFirstOrThrow({
      where: { code: 'EL' },
    });
    const leave = await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: leaveType.id,
        startDate: offsetDate(10),
        endDate: offsetDate(11),
      })
      .expect(201);
    const noDelegationLeaveId = (leave.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/leaves/${noDelegationLeaveId}/review`)
      .set('Authorization', `Bearer ${manager2Token}`)
      .send({ decision: 'APPROVED' })
      .expect(403);
  });

  it("manager1 (the employee's direct manager) can always review, no delegation needed", async () => {
    const leaveType = await prisma.leaveType.findFirstOrThrow({
      where: { code: 'EL' },
    });
    const leave = await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: leaveType.id,
        startDate: offsetDate(15),
        endDate: offsetDate(16),
      })
      .expect(201);
    const directLeaveId = (leave.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/leaves/${directLeaveId}/review`)
      .set('Authorization', `Bearer ${manager1Token}`)
      .send({ decision: 'APPROVED' })
      .expect(200);
  });

  it('rejects a delegation whose date range does not include today, and manager2 still gets 403', async () => {
    const created = await request(app.getHttpServer())
      .post('/delegations')
      .set('Authorization', `Bearer ${manager1Token}`)
      .send({
        delegate: manager2Id,
        fromDate: offsetDate(5),
        toDate: offsetDate(10),
      })
      .expect(201);
    const futureDelegationId = (created.body as DelegationBody).id;

    const leaveType = await prisma.leaveType.findFirstOrThrow({
      where: { code: 'EL' },
    });
    const leave = await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: leaveType.id,
        startDate: offsetDate(17),
        endDate: offsetDate(18),
      })
      .expect(201);
    const outOfRangeLeaveId = (leave.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/leaves/${outOfRangeLeaveId}/review`)
      .set('Authorization', `Bearer ${manager2Token}`)
      .send({ decision: 'APPROVED' })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/delegations/${futureDelegationId}/cancel`)
      .set('Authorization', `Bearer ${manager1Token}`)
      .expect(200);
  });

  let delegationId: string;

  it('MANAGER creates a delegation covering today', async () => {
    const res = await request(app.getHttpServer())
      .post('/delegations')
      .set('Authorization', `Bearer ${manager1Token}`)
      .send({
        delegate: manager2Id,
        fromDate: offsetDate(-1),
        toDate: offsetDate(1),
      })
      .expect(201);
    const body = res.body as DelegationBody;
    delegationId = body.id;
    expect(body.delegatorId).toBe(manager1Id);
    expect(body.delegateId).toBe(manager2Id);
    expect(body.isActive).toBe(true);
  });

  it('the delegator sees their own delegation in the default list', async () => {
    const res = await request(app.getHttpServer())
      .get('/delegations')
      .set('Authorization', `Bearer ${manager1Token}`)
      .expect(200);
    const body = res.body as DelegationBody[];
    expect(body.some((d) => d.id === delegationId)).toBe(true);
  });

  it("manager2's default list does not show manager1's delegation (delegator-scoped, not delegate-scoped)", async () => {
    const res = await request(app.getHttpServer())
      .get('/delegations')
      .set('Authorization', `Bearer ${manager2Token}`)
      .expect(200);
    const body = res.body as DelegationBody[];
    expect(body.some((d) => d.id === delegationId)).toBe(false);
  });

  it('HR can view via the delegator query param', async () => {
    const res = await request(app.getHttpServer())
      .get('/delegations')
      .query({ delegator: manager1Id })
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    const body = res.body as DelegationBody[];
    expect(body.some((d) => d.id === delegationId)).toBe(true);
  });

  it("a non-owner MANAGER gets 403 cancelling someone else's delegation", async () => {
    await request(app.getHttpServer())
      .patch(`/delegations/${delegationId}/cancel`)
      .set('Authorization', `Bearer ${manager2Token}`)
      .expect(403);
  });

  it('with an active delegation covering today, manager2 CAN review the employee leave', async () => {
    const leaveType = await prisma.leaveType.findFirstOrThrow({
      where: { code: 'EL' },
    });
    const leave = await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: leaveType.id,
        startDate: offsetDate(20),
        endDate: offsetDate(21),
      })
      .expect(201);
    const delegatedLeaveId = (leave.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/leaves/${delegatedLeaveId}/review`)
      .set('Authorization', `Bearer ${manager2Token}`)
      .send({ decision: 'APPROVED' })
      .expect(200);
  });

  it("cancelling the delegation revokes the delegate's review authority for future requests", async () => {
    await request(app.getHttpServer())
      .patch(`/delegations/${delegationId}/cancel`)
      .set('Authorization', `Bearer ${manager1Token}`)
      .expect(200);

    const leaveType = await prisma.leaveType.findFirstOrThrow({
      where: { code: 'EL' },
    });
    const leave = await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: leaveType.id,
        startDate: offsetDate(25),
        endDate: offsetDate(26),
      })
      .expect(201);
    const newLeaveId = (leave.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/leaves/${newLeaveId}/review`)
      .set('Authorization', `Bearer ${manager2Token}`)
      .send({ decision: 'APPROVED' })
      .expect(403);
  });

  it('404s cancelling a non-existent delegation', async () => {
    await request(app.getHttpServer())
      .patch('/delegations/00000000-0000-4000-8000-000000000000/cancel')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
