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
  employee?: { id: string; name: string; employeeId: string };
}
interface RepaymentResultBody {
  repayment: { id: string; principalComponent: number; balanceAfter: number };
  loan: LoanBody;
}
interface PaginatedBody<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
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
        // LOAN, not ADVANCE — an advance is always interest-free (see the
        // ADVANCE-specific tests below), so this needs the other type to
        // actually exercise the reducing-balance EMI path.
        loanType: 'LOAN',
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
    const loans = (res.body as PaginatedBody<LoanBody>).data;
    expect(loans.length).toBeGreaterThan(0);
    expect(loans.every((l) => l.employeeId === employeeId)).toBe(true);
  });

  it("another EMPLOYEE's list never includes this employee's loans", async () => {
    const res = await request(app.getHttpServer())
      .get('/loans')
      .set('Authorization', `Bearer ${otherEmployeeToken}`)
      .expect(200);
    const loans = (res.body as PaginatedBody<LoanBody>).data;
    expect(loans.every((l) => l.employeeId !== employeeId)).toBe(true);
  });

  it('list responses include the employee relation, not just the ID', async () => {
    const res = await request(app.getHttpServer())
      .get('/loans')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const [loan] = (res.body as PaginatedBody<LoanBody>).data;
    expect(loan.employee?.id).toBe(employeeId);
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
      .send({ status: 'CANCELLED', reason: 'Employee resigned' })
      .expect(200);
    expect((res.body as LoanBody).status).toBe('CANCELLED');
  });

  it('cancelling an active loan without a reason is rejected', async () => {
    const loan = await request(app.getHttpServer())
      .post('/loans')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        principal: 15000,
        tenureMonths: 3,
        startMonth: 9,
        startYear: 2026,
      })
      .expect(201);
    const id = (loan.body as LoanBody).id;

    await request(app.getHttpServer())
      .patch(`/loans/${id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'CANCELLED' })
      .expect(400);
  });

  it('closing an active loan with an outstanding balance and no reason is rejected', async () => {
    const loan = await request(app.getHttpServer())
      .post('/loans')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        principal: 18000,
        tenureMonths: 3,
        startMonth: 9,
        startYear: 2026,
      })
      .expect(201);
    const id = (loan.body as LoanBody).id;

    await request(app.getHttpServer())
      .patch(`/loans/${id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'CLOSED' })
      .expect(400);
  });

  it('closing an active loan with an outstanding balance and a reason succeeds and stamps closure fields', async () => {
    const loan = await request(app.getHttpServer())
      .post('/loans')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        principal: 22000,
        tenureMonths: 3,
        startMonth: 9,
        startYear: 2026,
      })
      .expect(201);
    const id = (loan.body as LoanBody).id;

    const res = await request(app.getHttpServer())
      .patch(`/loans/${id}/status`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ status: 'CLOSED', reason: 'Written off' })
      .expect(200);
    const body = res.body as LoanBody & {
      closureReason: string;
      closedAt: string | null;
      closedById: string | null;
    };
    expect(body.status).toBe('CLOSED');
    expect(body.closureReason).toBe('Written off');
    expect(body.closedAt).not.toBeNull();
    expect(body.closedById).toBeTruthy();

    // findAll() (the list the frontend's History modal reads its
    // `closedBy` from) must actually include the relation, not just the
    // scalar closedById — a bare `include: { employee }` would leave
    // `closedBy` undefined even though closedById is set.
    const listRes = await request(app.getHttpServer())
      .get('/loans')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    const listed = (
      listRes.body as PaginatedBody<
        LoanBody & { closedBy?: { id: string; name: string } }
      >
    ).data.find((l) => l.id === id);
    expect(listed?.closedBy?.name).toBeTruthy();
  });

  it('cancelling an active loan with a reason succeeds and stamps closure fields', async () => {
    const loan = await request(app.getHttpServer())
      .post('/loans')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        principal: 9000,
        tenureMonths: 3,
        startMonth: 9,
        startYear: 2026,
      })
      .expect(201);
    const id = (loan.body as LoanBody).id;

    const res = await request(app.getHttpServer())
      .patch(`/loans/${id}/status`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ status: 'CANCELLED', reason: 'Recorded in error' })
      .expect(200);
    const body = res.body as LoanBody & {
      closureReason: string;
      closedAt: string | null;
      closedById: string | null;
    };
    expect(body.status).toBe('CANCELLED');
    expect(body.closureReason).toBe('Recorded in error');
    expect(body.closedAt).not.toBeNull();
    expect(body.closedById).toBeTruthy();
  });

  it('closing a loan with a zero outstanding balance does not require a reason', async () => {
    const loan = await request(app.getHttpServer())
      .post('/loans')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        principal: 4000,
        tenureMonths: 2,
        startMonth: 9,
        startYear: 2026,
      })
      .expect(201);
    const id = (loan.body as LoanBody).id;

    await request(app.getHttpServer())
      .post(`/loans/${id}/repayments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: 9, year: 2026, amount: 4000 })
      .expect(201);

    // The repayment already auto-closed the loan (see the auto-close test
    // above) — flip it back to ACTIVE first so the CLOSED status endpoint
    // actually has a transition to make.
    await prisma.loan.update({ where: { id }, data: { status: 'ACTIVE' } });

    const res = await request(app.getHttpServer())
      .patch(`/loans/${id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'CLOSED' })
      .expect(200);
    const body = res.body as LoanBody;
    expect(body.status).toBe('CLOSED');
    expect(body.outstandingBalance).toBe(0);
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
    const loans = (res.body as PaginatedBody<LoanBody>).data;
    expect(loans.length).toBeGreaterThan(0);
    expect(loans.every((l) => l.status === 'CLOSED')).toBe(true);
  });

  describe('self-service request -> approve/reject', () => {
    it('an employee can request a loan for themselves, landing PENDING', async () => {
      const res = await request(app.getHttpServer())
        .post('/loans/request')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          loanType: 'ADVANCE',
          principal: 50000,
          tenureMonths: 5,
          reason: 'Medical',
        })
        .expect(201);
      const loan = res.body as LoanBody;
      expect(loan.status).toBe('PENDING');
      expect(loan.employeeId).toBe(employeeId);
    });

    it('the request DTO has no employeeId field — it is always the caller (global whitelist rejects one)', async () => {
      await request(app.getHttpServer())
        .post('/loans/request')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({ employeeId, principal: 10000, tenureMonths: 2 })
        .expect(400);
    });

    it('HR approving sets the real terms and flips it ACTIVE', async () => {
      const req = await request(app.getHttpServer())
        .post('/loans/request')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ principal: 30000, tenureMonths: 6 })
        .expect(201);
      const id = (req.body as LoanBody).id;

      const approved = await request(app.getHttpServer())
        .patch(`/loans/${id}/approve`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ startMonth: 4, startYear: 2027, interestRate: 5 })
        .expect(200);
      const body = approved.body as LoanBody;
      expect(body.status).toBe('ACTIVE');
      expect(body.outstandingBalance).toBe(30000);
    });

    it('HR rejecting sets it REJECTED, not ACTIVE', async () => {
      const req = await request(app.getHttpServer())
        .post('/loans/request')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ principal: 15000, tenureMonths: 3 })
        .expect(201);
      const id = (req.body as LoanBody).id;

      const rejected = await request(app.getHttpServer())
        .patch(`/loans/${id}/reject`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ reason: 'Not eligible yet' })
        .expect(200);
      expect((rejected.body as LoanBody).status).toBe('REJECTED');
    });

    it('rejects approving/rejecting a non-pending loan', async () => {
      const req = await request(app.getHttpServer())
        .post('/loans/request')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ principal: 8000, tenureMonths: 2 })
        .expect(201);
      const id = (req.body as LoanBody).id;
      await request(app.getHttpServer())
        .patch(`/loans/${id}/approve`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ startMonth: 1, startYear: 2027 })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/loans/${id}/approve`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ startMonth: 1, startYear: 2027 })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/loans/${id}/reject`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({})
        .expect(400);
    });

    it('the generic status endpoint refuses a still-pending loan', async () => {
      const req = await request(app.getHttpServer())
        .post('/loans/request')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ principal: 9000, tenureMonths: 2 })
        .expect(201);
      const id = (req.body as LoanBody).id;
      await request(app.getHttpServer())
        .patch(`/loans/${id}/status`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'CANCELLED' })
        .expect(400);
    });

    it('an ADVANCE cannot be approved with a non-zero interest rate', async () => {
      const req = await request(app.getHttpServer())
        .post('/loans/request')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ loanType: 'ADVANCE', principal: 12000, tenureMonths: 1 })
        .expect(201);
      const id = (req.body as LoanBody).id;
      await request(app.getHttpServer())
        .patch(`/loans/${id}/approve`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ startMonth: 1, startYear: 2027, interestRate: 3 })
        .expect(400);
      // 0% (or omitted, defaulting to 0%) goes through fine.
      const approved = await request(app.getHttpServer())
        .patch(`/loans/${id}/approve`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ startMonth: 1, startYear: 2027 })
        .expect(200);
      expect(
        (approved.body as LoanBody & { interestRate: number }).interestRate,
      ).toBe(0);
    });

    it('a direct HR-created ADVANCE also rejects a non-zero interest rate', async () => {
      await request(app.getHttpServer())
        .post('/loans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          employeeId,
          loanType: 'ADVANCE',
          principal: 5000,
          interestRate: 2,
          tenureMonths: 1,
          startMonth: 1,
          startYear: 2027,
        })
        .expect(400);
    });

    it('HR cannot approve their own loan request (self-approval blocked)', async () => {
      const req = await request(app.getHttpServer())
        .post('/loans/request')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ principal: 6000, tenureMonths: 2 })
        .expect(201);
      const id = (req.body as LoanBody).id;
      await request(app.getHttpServer())
        .patch(`/loans/${id}/approve`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ startMonth: 1, startYear: 2027 })
        .expect(403);
      // An Admin can still approve it, though — the exemption is Admin-only.
      await request(app.getHttpServer())
        .patch(`/loans/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ startMonth: 1, startYear: 2027 })
        .expect(200);
    });

    it('an EMPLOYEE cannot approve or reject (HR/Admin only)', async () => {
      const req = await request(app.getHttpServer())
        .post('/loans/request')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({ principal: 7000, tenureMonths: 2 })
        .expect(201);
      const id = (req.body as LoanBody).id;
      await request(app.getHttpServer())
        .patch(`/loans/${id}/approve`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ startMonth: 1, startYear: 2027 })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/loans/${id}/reject`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(403);
    });
  });
});
