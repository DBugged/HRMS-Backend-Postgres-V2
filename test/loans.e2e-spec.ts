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
interface LoanBody {
  id: string;
  status: string;
  employeeId: string;
  principal: number;
  emiAmount: number;
  outstandingBalance: number;
}
interface RepaymentResultBody {
  repayment: { id: string; principalComponent: number; balanceAfter: number };
  loan: LoanBody;
}

const PASSWORD = 'TestPass123!';

describe('Loans (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
  let employeeId: string;
  let otherEmployeeToken: string;

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
      organizationName: 'Loans E2E Org',
      name: 'Founder',
      email: 'loan-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'loan-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'loan-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'loan-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'loan-e2e-emp@example.test' });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'loan-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const otherCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Other Employee', email: 'loan-e2e-other@example.test' });
    const otherLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'loan-e2e-other@example.test',
        password: (otherCreate.body as EmployeeCreateBody).generatedPassword,
      });
    otherEmployeeToken = (otherLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "loan_repayments", "loans", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403 creating a loan', async () => {
    await request(app.getHttpServer())
      .post('/loans')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        employeeId,
        principal: 120000,
        tenureMonths: 12,
        startMonth: 6,
        startYear: 2026,
      })
      .expect(403);
  });

  let loanId: string;

  it('ADMIN creates an interest-free loan with a flat EMI', async () => {
    const res = await request(app.getHttpServer())
      .post('/loans')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        principal: 120000,
        tenureMonths: 12,
        startMonth: 6,
        startYear: 2026,
        reason: 'Medical emergency',
      })
      .expect(201);
    const body = res.body as LoanBody;
    loanId = body.id;
    expect(body.status).toBe('ACTIVE');
    expect(body.emiAmount).toBe(10000); // 120000 / 12, no interest
    expect(body.outstandingBalance).toBe(120000);
  });

  it('HR creates an interest-bearing loan with a reducing-balance EMI', async () => {
    const res = await request(app.getHttpServer())
      .post('/loans')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        employeeId,
        loanType: 'ADVANCE',
        principal: 100000,
        interestRate: 12,
        tenureMonths: 12,
        startMonth: 7,
        startYear: 2026,
      })
      .expect(201);
    const body = res.body as LoanBody;
    expect(body.emiAmount).toBe(8885);
  });

  it('EMPLOYEE only sees their own loans', async () => {
    const res = await request(app.getHttpServer())
      .get('/loans')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const loans = res.body as LoanBody[];
    expect(loans.length).toBeGreaterThan(0);
    expect(loans.every((l) => l.employeeId === employeeId)).toBe(true);
  });

  it("another EMPLOYEE's list never includes this employee's loans", async () => {
    const res = await request(app.getHttpServer())
      .get('/loans')
      .set('Authorization', `Bearer ${otherEmployeeToken}`)
      .expect(200);
    const loans = res.body as LoanBody[];
    expect(loans.every((l) => l.employeeId !== employeeId)).toBe(true);
  });

  it('EMPLOYEE gets 403 reading repayments for a loan that is not theirs', async () => {
    // otherEmployee has no loans of their own; use the first loan (owned by
    // `employeeId`) to prove ownership is enforced, not just "any 403".
    await request(app.getHttpServer())
      .get(`/loans/${loanId}/repayments`)
      .set('Authorization', `Bearer ${otherEmployeeToken}`)
      .expect(403);
  });

  it('the owning EMPLOYEE can read their own (empty) repayment history', async () => {
    const res = await request(app.getHttpServer())
      .get(`/loans/${loanId}/repayments`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it('EMPLOYEE gets 403 recording a repayment', async () => {
    await request(app.getHttpServer())
      .post(`/loans/${loanId}/repayments`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ month: 6, year: 2026, amount: 10000 })
      .expect(403);
  });

  it('HR records a partial repayment, reducing the outstanding balance', async () => {
    const res = await request(app.getHttpServer())
      .post(`/loans/${loanId}/repayments`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ month: 6, year: 2026, amount: 10000 })
      .expect(201);
    const body = res.body as RepaymentResultBody;
    expect(body.repayment.principalComponent).toBe(10000);
    expect(body.repayment.balanceAfter).toBe(110000);
    expect(body.loan.outstandingBalance).toBe(110000);
    expect(body.loan.status).toBe('ACTIVE');
  });

  it('a repayment that clears the outstanding balance auto-closes the loan', async () => {
    const res = await request(app.getHttpServer())
      .post(`/loans/${loanId}/repayments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: 7, year: 2026, amount: 110000 })
      .expect(201);
    const body = res.body as RepaymentResultBody;
    expect(body.loan.outstandingBalance).toBe(0);
    expect(body.loan.status).toBe('CLOSED');
  });

  it('repayments overpaying the outstanding balance clamp the principal component and never go negative', async () => {
    const loan = await request(app.getHttpServer())
      .post('/loans')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        principal: 5000,
        tenureMonths: 5,
        startMonth: 8,
        startYear: 2026,
      })
      .expect(201);
    const smallLoanId = (loan.body as LoanBody).id;

    const res = await request(app.getHttpServer())
      .post(`/loans/${smallLoanId}/repayments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: 8, year: 2026, amount: 9000 })
      .expect(201);
    const body = res.body as RepaymentResultBody;
    expect(body.repayment.principalComponent).toBe(5000);
    expect(body.loan.outstandingBalance).toBe(0);
    expect(body.loan.status).toBe('CLOSED');
  });

  it('the owning EMPLOYEE now sees the recorded repayment history', async () => {
    const res = await request(app.getHttpServer())
      .get(`/loans/${loanId}/repayments`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const repayments = res.body as { amount: number }[];
    expect(repayments.length).toBe(2);
  });

  it('404s recording a repayment against a non-existent loan', async () => {
    await request(app.getHttpServer())
      .post('/loans/00000000-0000-4000-8000-000000000000/repayments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: 6, year: 2026, amount: 100 })
      .expect(404);
  });

  it('EMPLOYEE gets 403 updating loan status', async () => {
    await request(app.getHttpServer())
      .patch(`/loans/${loanId}/status`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ status: 'CANCELLED' })
      .expect(403);
  });

  it('ADMIN can cancel an active loan directly', async () => {
    const loan = await request(app.getHttpServer())
      .post('/loans')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        principal: 20000,
        tenureMonths: 4,
        startMonth: 9,
        startYear: 2026,
      })
      .expect(201);
    const cancelLoanId = (loan.body as LoanBody).id;

    const res = await request(app.getHttpServer())
      .patch(`/loans/${cancelLoanId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'CANCELLED' })
      .expect(200);
    expect((res.body as LoanBody).status).toBe('CANCELLED');
  });

  it('rejects an invalid status value', async () => {
    await request(app.getHttpServer())
      .patch(`/loans/${loanId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'NOT_A_STATUS' })
      .expect(400);
  });

  it('404s updating status for a non-existent loan', async () => {
    await request(app.getHttpServer())
      .patch('/loans/00000000-0000-4000-8000-000000000000/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'CLOSED' })
      .expect(404);
  });

  it('ADMIN list can be filtered by employeeId and status', async () => {
    const res = await request(app.getHttpServer())
      .get('/loans')
      .query({ employeeId, status: 'CLOSED' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const loans = res.body as LoanBody[];
    expect(loans.length).toBeGreaterThan(0);
    expect(loans.every((l) => l.status === 'CLOSED')).toBe(true);
  });
});
