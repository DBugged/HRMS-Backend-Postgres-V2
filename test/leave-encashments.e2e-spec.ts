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
interface LeaveTypeBody {
  id: string;
}
interface EncashmentBody {
  id: string;
  status: string;
  days: number;
  ratePerDay: number;
  amount: number;
  financialYear: string;
  employeeId: string;
}

const PASSWORD = 'TestPass123!';
const BASIC_MONTHLY = 30000; // defaultValue on the BASIC SalaryComponent

describe('Leave Encashments (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
  let employeeId: string;

  let encashableLeaveTypeId: string;
  let noEncashLeaveTypeId: string;

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
      organizationName: 'Leave Encashment E2E Org',
      name: 'Founder',
      email: 'lenc-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'lenc-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'lenc-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'lenc-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'lenc-e2e-emp@example.test' });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'lenc-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    // BASIC component with a known defaultValue — with no per-employee
    // override, getCurrentMonthlyValue resolves straight to this.
    await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Basic',
        code: 'BASIC',
        type: 'EARNING',
        calcType: 'FIXED',
        defaultValue: BASIC_MONTHLY,
      })
      .expect(201);

    const encashableType = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Earned Leave',
        code: 'EL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 24,
        prorateOnJoining: false,
        encashment: { allowed: true, maxDaysPerYear: 5, minBalanceToRetain: 2 },
      });
    encashableLeaveTypeId = (encashableType.body as LeaveTypeBody).id;

    const noEncashType = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Sick Leave',
        code: 'SL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 12,
        prorateOnJoining: false,
      });
    noEncashLeaveTypeId = (noEncashType.body as LeaveTypeBody).id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "leave_encashments", "leave_balances", "leave_types", "employee_salary_components", "salary_components", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('rejects a leave type that does not allow encashment', async () => {
    await request(app.getHttpServer())
      .post('/leave-encashments')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ days: 1, leaveType: noEncashLeaveTypeId })
      .expect(400);
  });

  it('rejects a request exceeding maxDaysPerYear', async () => {
    await request(app.getHttpServer())
      .post('/leave-encashments')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ days: 6, leaveType: encashableLeaveTypeId })
      .expect(400);
  });

  it('rejects a request that would breach minBalanceToRetain, reporting the correct max', async () => {
    // 24 credited, minBalanceToRetain 2 -> max encashable is 22; asking for
    // 23 (still <= maxDaysPerYear 5? no — 23 > 5, so this would 400 on the
    // maxDaysPerYear check first). Use a days value under maxDaysPerYear
    // but engineered against a fresh balance to isolate the retain check:
    // with a full 24-day balance, any value <=5 always leaves >=19 days
    // retained, so instead assert via a value that trips retention on a
    // type without a maxDaysPerYear cap.
    const uncappedType = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Casual Leave',
        code: 'CL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 3,
        prorateOnJoining: false,
        encashment: { allowed: true, minBalanceToRetain: 2 },
      });
    const uncappedTypeId = (uncappedType.body as LeaveTypeBody).id;

    // 3 credited, retain 2 -> max encashable 1. Asking for 2 should fail.
    const res = await request(app.getHttpServer())
      .post('/leave-encashments')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ days: 2, leaveType: uncappedTypeId })
      .expect(400);
    expect((res.body as { message: string }).message).toContain('1 day(s)');
  });

  let encashmentId: string;

  it('computes ratePerDay/amount/financialYear from the current BASIC value', async () => {
    const res = await request(app.getHttpServer())
      .post('/leave-encashments')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ days: 3, leaveType: encashableLeaveTypeId })
      .expect(201);
    const body = res.body as EncashmentBody;
    encashmentId = body.id;
    expect(body.employeeId).toBe(employeeId);
    expect(body.status).toBe('PENDING');
    expect(body.ratePerDay).toBe(BASIC_MONTHLY / 30);
    expect(body.amount).toBe(Math.round((BASIC_MONTHLY / 30) * 3));
    expect(body.financialYear).toMatch(/^\d{4}-\d{2}$/);
  });

  it('EMPLOYEE only sees their own requests', async () => {
    const res = await request(app.getHttpServer())
      .get('/leave-encashments')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const rows = res.body as EncashmentBody[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.employeeId === employeeId)).toBe(true);
  });

  it('EMPLOYEE gets 403 reviewing a request', async () => {
    await request(app.getHttpServer())
      .patch(`/leave-encashments/${encashmentId}/review`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ status: 'APPROVED' })
      .expect(403);
  });

  it('HR approves; the balance encashed/closing are updated (a second, independent deduction)', async () => {
    const before = await prisma.leaveBalance.findFirstOrThrow({
      where: { employeeId, leaveTypeId: encashableLeaveTypeId },
    });

    const res = await request(app.getHttpServer())
      .patch(`/leave-encashments/${encashmentId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ status: 'APPROVED' })
      .expect(200);
    expect((res.body as EncashmentBody).status).toBe('APPROVED');

    const after = await prisma.leaveBalance.findFirstOrThrow({
      where: { employeeId, leaveTypeId: encashableLeaveTypeId },
    });
    expect(after.encashed).toBe(before.encashed + 3);
    expect(after.closing).toBe(before.closing - 3);
  });

  it('review can transition APPROVED -> PROCESSED', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/leave-encashments/${encashmentId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ status: 'PROCESSED' })
      .expect(200);
    expect((res.body as EncashmentBody).status).toBe('PROCESSED');
  });
});
