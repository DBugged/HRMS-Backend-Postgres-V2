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
}

const PASSWORD = 'TestPass123!';
const DAY = 86_400_000;
const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

// GET /employees/onboarding-documents: per-employee mandatory-document progress for the Pending Onboarding list.
describe('Onboarding document progress (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let organizationId: string;

  const call = (method: 'post' | 'patch' | 'get', url: string) =>
    request(app.getHttpServer())
      [method](url)
      .set('Authorization', `Bearer ${adminToken}`);
  const hire = async (name: string, email: string) =>
    (
      (
        await call('post', '/employees')
          .send({ name, email, joiningDate: '2026-10-01' })
          .expect(201)
      ).body as EmployeeCreateBody
    ).employee.id;
  const upload = (employeeId: string, docType: string, status: string) =>
    prisma.employeeDocument.create({
      data: {
        organizationId,
        employeeId,
        docType,
        status: status as 'PENDING',
        fileName: `${docType}.pdf`,
        fileUrl: `${employeeId}/documents/${docType}.pdf`,
      },
    });

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
      organizationName: 'Onboarding Docs Org',
      name: 'Founder',
      email: 'od-admin@example.test',
      password: PASSWORD,
    });
    adminToken = (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'od-admin@example.test', password: PASSWORD })
      ).body as AuthBody
    ).accessToken;
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'od-admin@example.test' },
      })
    ).organizationId;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('counts each mandatory requirement once by the best state reached, and leaves out non-onboarding staff', async () => {
    await prisma.documentRequirement.deleteMany({ where: { organizationId } });
    for (const name of ['R-Approved', 'R-Pending', 'R-Rejected', 'R-Missing']) {
      await prisma.documentRequirement.create({
        data: { organizationId, name, isMandatory: true },
      });
    }
    await prisma.documentRequirement.create({
      data: { organizationId, name: 'R-Optional', isMandatory: false },
    });
    const id = await hire('Doc Progress', 'od-one@example.test');
    // A rejected upload followed by an approved one for the same type counts as approved.
    await upload(id, 'R-Approved', 'REJECTED');
    await upload(id, 'R-Approved', 'APPROVED');
    await upload(id, 'R-Pending', 'PENDING');
    await upload(id, 'R-Rejected', 'REJECTED');
    await upload(id, 'R-Optional', 'APPROVED');
    const confirmed = await hire('Confirmed One', 'od-two@example.test');
    await call('patch', `/employees/${confirmed}`)
      .send({ employmentStatus: 'CONFIRMED' })
      .expect(200);

    const res = await call('get', '/employees/onboarding-documents').expect(
      200,
    );
    const rows = (
      res.body as {
        data: {
          employeeId: string;
          required: number;
          approved: number;
          pending: number;
          rejected: number;
          missing: number;
        }[];
      }
    ).data;
    const mine = rows.find((r) => r.employeeId === id);
    expect(mine).toEqual({
      employeeId: id,
      required: 4,
      approved: 1,
      pending: 1,
      rejected: 1,
      missing: 1,
    });
    expect(rows.find((r) => r.employeeId === confirmed)).toBeUndefined();
  });

  it('is not available to an employee', async () => {
    const id = await hire('Plain Staff', 'od-staff@example.test');
    await prisma.user.update({
      where: { id },
      data: {
        password: (
          await prisma.user.findFirstOrThrow({
            where: { email: 'od-admin@example.test' },
          })
        ).password,
      },
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'od-staff@example.test', password: PASSWORD });
    const token = (login.body as AuthBody).accessToken;
    await request(app.getHttpServer())
      .get('/employees/onboarding-documents')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
