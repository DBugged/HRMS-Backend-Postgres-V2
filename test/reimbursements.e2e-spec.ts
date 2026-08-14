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
    const claims = res.body as ReimbursementBody[];
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.employeeId === employeeId)).toBe(true);
  });

  it("another EMPLOYEE's list never includes claims that aren't theirs", async () => {
    const res = await request(app.getHttpServer())
      .get('/reimbursements')
      .set('Authorization', `Bearer ${otherEmployeeToken}`)
      .expect(200);
    const claims = res.body as ReimbursementBody[];
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
    const res = await request(app.getHttpServer())
      .patch(`/reimbursements/${claimId}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'PAID' })
      .expect(200);
    expect((res.body as ReimbursementBody).status).toBe('PAID');
  });

  it('ADMIN sees every claim and can filter by status', async () => {
    const res = await request(app.getHttpServer())
      .get('/reimbursements')
      .query({ status: 'PAID' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const claims = res.body as ReimbursementBody[];
    expect(claims.some((c) => c.id === claimId)).toBe(true);
    expect(claims.every((c) => c.status === 'PAID')).toBe(true);
  });
});
