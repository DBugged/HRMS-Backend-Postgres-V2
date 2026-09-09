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
import {
  disablePasswordRotationGuard,
  restorePasswordRotationGuard,
} from './password-rotation-guard.testing';

interface AuthBody {
  accessToken: string;
  user: { id: string; mustChangePassword: boolean };
}
interface EmployeeBody {
  employee: { id: string };
  generatedPassword: string;
}

const PASSWORD = 'TestPass123!';
const ADMIN_EMAIL = 'pwrotation-e2e-admin@example.test';
const EMPLOYEE_EMAIL = 'pwrotation-e2e-employee@example.test';

// Covers PasswordRotationGuard end to end: a user still holding an emailed
// temporary password must not be able to drive the API. Only the tiny
// allowlist the force-change screen itself needs (@AllowPendingPasswordChange)
// stays reachable until the password is actually rotated.
describe('Password rotation enforcement (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let tempToken: string;
  let tempPassword: string;
  let employeeUserId: string;

  beforeAll(async () => {
    // test/setup-e2e.ts disables the guard for every other suite (their
    // fixtures log in with the temporary password POST /employees returns).
    // This is the suite that actually exercises it.
    restorePasswordRotationGuard();

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
      organizationName: 'Password Rotation E2E Org',
      name: 'Founder',
      email: ADMIN_EMAIL,
      password: PASSWORD,
    });

    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const created = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Temp Password Employee',
        email: EMPLOYEE_EMAIL,
        role: 'EMPLOYEE',
      });
    const body = created.body as EmployeeBody;
    tempPassword = body.generatedPassword;
    employeeUserId = body.employee.id;

    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: EMPLOYEE_EMAIL, password: tempPassword });
    tempToken = (empLogin.body as AuthBody).accessToken;
  });

  beforeEach(async () => {
    // The last test rotates the password for real; put the flag back so each
    // test starts from "still on a temporary password". Safe because
    // JwtAccessStrategy re-reads the user row per request — which is also
    // exactly why the guard bites on an already-issued token.
    await prisma.user.updateMany({
      where: { id: employeeUserId },
      data: { mustChangePassword: true },
    });
  });

  afterAll(async () => {
    disablePasswordRotationGuard();
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it.each([['/leaves'], ['/attendance'], ['/employees'], ['/notifications']])(
    'blocks %s while the temporary password has not been rotated',
    async (url) => {
      await request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${tempToken}`)
        .expect(403);
    },
  );

  it('still allows the allowlisted routes the force-change screen needs', async () => {
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tempToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get('/organizations/settings/public')
      .set('Authorization', `Bearer ${tempToken}`)
      .expect(200);
  });

  it('does not affect a user whose password is already rotated', async () => {
    await request(app.getHttpServer())
      .get('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('unblocks the API once the password is actually changed', async () => {
    await request(app.getHttpServer())
      .get('/leaves')
      .set('Authorization', `Bearer ${tempToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ currentPassword: tempPassword, newPassword: 'RotatedPass123!' })
      .expect(201);

    // Same token as before the rotation — no re-login required.
    await request(app.getHttpServer())
      .get('/leaves')
      .set('Authorization', `Bearer ${tempToken}`)
      .expect(200);
  });
});
