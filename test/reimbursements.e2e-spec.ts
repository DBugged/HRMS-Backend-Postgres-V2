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
interface ReimbursementBody {
  id: string;
  status: string;
  category: string;
  amount: number;
  employeeId: string;
  reviewComments: string;
  receiptUrl?: string;
  employee?: { id: string; name: string; employeeId: string };
}
interface PaginatedReimbursements {
  data: ReimbursementBody[];
  total: number;
  page: number;
  limit: number;
}

const PASSWORD = 'TestPass123!';

describe('Reimbursements (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
  let employeeId: string;
  let otherEmployeeToken: string;
  let managerToken: string;
  let managerId: string;
  let deptEmployeeId: string;
  let deptEmployeeToken: string;

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
      organizationName: 'Reimbursements E2E Org',
      name: 'Founder',
      email: 'reimb-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'reimb-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'reimb-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'reimb-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'reimb-e2e-emp@example.test' });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'reimb-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const otherCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Other Employee', email: 'reimb-e2e-other@example.test' });
    const otherLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'reimb-e2e-other@example.test',
        password: (otherCreate.body as EmployeeCreateBody).generatedPassword,
      });
    otherEmployeeToken = (otherLogin.body as AuthBody).accessToken;

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
        email: 'reimb-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    managerId = (managerCreate.body as EmployeeCreateBody).employee.id;
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'reimb-e2e-manager@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const deptEmpCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Dept Employee',
        email: 'reimb-e2e-dept-emp@example.test',
        departmentId,
      });
    const deptEmpBody = deptEmpCreate.body as EmployeeCreateBody;
    deptEmployeeId = deptEmpBody.employee.id;
    const deptEmpLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'reimb-e2e-dept-emp@example.test',
        password: deptEmpBody.generatedPassword,
      });
    deptEmployeeToken = (deptEmpLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "reimbursements", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('rejects an amount over the sanity ceiling', async () => {
    await request(app.getHttpServer())
      .post('/reimbursements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ amount: 20000000, claimDate: '2026-06-10' })
      .expect(400);
  });

  it('rejects a non-positive amount', async () => {
    await request(app.getHttpServer())
      .post('/reimbursements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ amount: 0, claimDate: '2026-06-10' })
      .expect(400);
  });

  let claimId: string;

  it('an EMPLOYEE creates a claim for themselves, defaulting to PENDING/OTHER', async () => {
    const res = await request(app.getHttpServer())
      .post('/reimbursements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ amount: 1500, claimDate: '2026-06-10', description: 'Taxi' })
      .expect(201);
    const body = res.body as ReimbursementBody;
    claimId = body.id;
    expect(body.employeeId).toBe(employeeId);
    expect(body.status).toBe('PENDING');
    expect(body.category).toBe('OTHER');
  });

  it('a specific category is honored', async () => {
    const res = await request(app.getHttpServer())
      .post('/reimbursements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ amount: 500, claimDate: '2026-06-11', category: 'TRAVEL' })
      .expect(201);
    expect((res.body as ReimbursementBody).category).toBe('TRAVEL');
  });

  it('EMPLOYEE only sees their own claims', async () => {
    const res = await request(app.getHttpServer())
      .get('/reimbursements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const claims = (res.body as PaginatedReimbursements).data;
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.employeeId === employeeId)).toBe(true);
  });

  it('list responses include the employee relation, not just the ID', async () => {
    const res = await request(app.getHttpServer())
      .get('/reimbursements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const [claim] = (res.body as { data: ReimbursementBody[] }).data;
    expect(claim.employee?.id).toBe(employeeId);
  });

  it('a stored receiptUrl relativeKey comes back signed as /files/<token>, not the raw key', async () => {
    const created = await request(app.getHttpServer())
      .post('/reimbursements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        amount: 250,
        claimDate: '2026-06-12',
        receiptUrl: 'documents/some-org/receipt.pdf',
      })
      .expect(201);
    const body = created.body as ReimbursementBody;
    expect(body.receiptUrl).toMatch(/^\/files\//);
    expect(body.receiptUrl).not.toBe('documents/some-org/receipt.pdf');

    const list = await request(app.getHttpServer())
      .get('/reimbursements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const same = (list.body as { data: ReimbursementBody[] }).data.find(
      (c) => c.id === body.id,
    );
    expect(same?.receiptUrl).toMatch(/^\/files\//);
  });

  it("another EMPLOYEE's list never includes claims that aren't theirs", async () => {
    const res = await request(app.getHttpServer())
      .get('/reimbursements')
      .set('Authorization', `Bearer ${otherEmployeeToken}`)
      .expect(200);
    const claims = (res.body as { data: ReimbursementBody[] }).data;
    expect(claims.every((c) => c.employeeId !== employeeId)).toBe(true);
  });

  it('EMPLOYEE gets 403 reviewing a claim', async () => {
    await request(app.getHttpServer())
      .patch(`/reimbursements/${claimId}/review`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ status: 'APPROVED' })
      .expect(403);
  });

  it('rejects an invalid review status', async () => {
    await request(app.getHttpServer())
      .patch(`/reimbursements/${claimId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ status: 'NOT_A_STATUS' })
      .expect(400);
  });

  it('404s reviewing a non-existent claim', async () => {
    await request(app.getHttpServer())
      .patch('/reimbursements/00000000-0000-4000-8000-000000000000/review')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ status: 'APPROVED' })
      .expect(404);
  });

  it('HR approves a claim with review comments', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/reimbursements/${claimId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ status: 'APPROVED', reviewComments: 'Looks good' })
      .expect(200);
    const body = res.body as ReimbursementBody;
    expect(body.status).toBe('APPROVED');
    expect(body.reviewComments).toBe('Looks good');
  });

  it('ADMIN can transition an approved claim to PAID', async () => {
    // paymentMode is required for a PAID transition (see
    // ReimbursementsService.review's own guard) — without it this 400s.
    const res = await request(app.getHttpServer())
      .patch(`/reimbursements/${claimId}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'PAID', paymentMode: 'TRANSFER' })
      .expect(200);
    expect((res.body as ReimbursementBody).status).toBe('PAID');
  });

  it('ADMIN sees every claim and can filter by status', async () => {
    const res = await request(app.getHttpServer())
      .get('/reimbursements')
      .query({ status: 'PAID' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const claims = (res.body as { data: ReimbursementBody[] }).data;
    expect(claims.some((c) => c.id === claimId)).toBe(true);
    expect(claims.every((c) => c.status === 'PAID')).toBe(true);
  });

  describe('MANAGER scoping (?employeeId=self is My Reimbursements)', () => {
    let managerClaimId: string;
    let deptEmployeeClaimId: string;

    beforeAll(async () => {
      const managerClaim = await request(app.getHttpServer())
        .post('/reimbursements')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          amount: 800,
          claimDate: '2026-06-12',
          description: 'Manager cab',
        })
        .expect(201);
      managerClaimId = (managerClaim.body as ReimbursementBody).id;

      const deptEmpClaim = await request(app.getHttpServer())
        .post('/reimbursements')
        .set('Authorization', `Bearer ${deptEmployeeToken}`)
        .send({
          amount: 600,
          claimDate: '2026-06-12',
          description: 'Dept employee lunch',
        })
        .expect(201);
      deptEmployeeClaimId = (deptEmpClaim.body as ReimbursementBody).id;
    });

    it('with no employeeId filter, MANAGER sees the whole department (existing behavior, unchanged)', async () => {
      const res = await request(app.getHttpServer())
        .get('/reimbursements')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const ids = (res.body as { data: ReimbursementBody[] }).data.map(
        (c) => c.id,
      );
      expect(ids).toContain(managerClaimId);
      expect(ids).toContain(deptEmployeeClaimId);
    });

    it('?employeeId=self ("My Reimbursements") scopes to only the manager\'s own claims', async () => {
      const res = await request(app.getHttpServer())
        .get('/reimbursements')
        .query({ employeeId: managerId })
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const claims = (res.body as { data: ReimbursementBody[] }).data;
      expect(claims.every((c) => c.employeeId === managerId)).toBe(true);
      expect(claims.some((c) => c.id === managerClaimId)).toBe(true);
    });

    it('?employeeId=<another dept member> narrows to just that member', async () => {
      const res = await request(app.getHttpServer())
        .get('/reimbursements')
        .query({ employeeId: deptEmployeeId })
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const claims = (res.body as { data: ReimbursementBody[] }).data;
      expect(claims.every((c) => c.employeeId === deptEmployeeId)).toBe(true);
      expect(claims.some((c) => c.id === deptEmployeeClaimId)).toBe(true);
    });

    it('?employeeId=<someone outside the department> is refused, not silently ignored', async () => {
      await request(app.getHttpServer())
        .get('/reimbursements')
        .query({ employeeId })
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
    });
  });
});
