import * as path from 'path';
import * as dotenv from 'dotenv';

// Loaded before AppModule's providers are ever instantiated (that happens
// later, inside moduleFixture.compile() in beforeAll) — points every env
// var PrismaService/AuthService read (DATABASE_URL, JWT secrets, ...) at
// the dedicated hrms_v2_test database, never the dev one used for manual
// Swagger/curl exploration.
dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import * as bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// supertest's `res.body` is typed `any` — these mirror the real DTOs
// (auth-response.dto.ts, register response) just enough to keep the
// assertions below type-checked instead of trusting `any` throughout.
interface RegisterBody {
  organizationId: string;
  userId: string;
}
interface AuthBody {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { role: string };
}

/**
 * Automates the exact manual curl-based verification run against this
 * phase's plan (register -> login -> RBAC across all 4 roles -> refresh
 * rotation -> logout revocation -> mobile no-cookie-jar path), so it's no
 * longer something that only got checked once by hand.
 */
describe('Auth + RBAC (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const testEmails = {
    admin: 'e2e-admin@example.test',
    hr: 'e2e-hr@example.test',
    manager: 'e2e-manager@example.test',
    employee: 'e2e-employee@example.test',
  };
  const password = 'TestPass123!';
  let organizationId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mirrors main.ts's bootstrap() exactly — the e2e app is created
    // directly from AppModule rather than by calling bootstrap(), so the
    // same middleware/pipes have to be wired here too or cookie parsing
    // and DTO validation wouldn't actually be under test.
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
  });

  afterAll(async () => {
    // Disposable test database — full truncate rather than scoped deletes,
    // so a failed run never leaves stale rows that make the next run's
    // "email already exists" checks fail for the wrong reason.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('registers a new organization + ADMIN founder, issuing no tokens yet', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'E2E Test Org',
        name: 'E2E Founder',
        email: testEmails.admin,
        password,
      })
      .expect(201);

    const body = res.body as RegisterBody;
    expect(body.organizationId).toEqual(expect.any(String));
    expect(body.userId).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty('accessToken');
    organizationId = body.organizationId;
  });

  it('rejects a second registration with the same email', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Another Org',
        name: 'Someone Else',
        email: testEmails.admin,
        password,
      })
      .expect(409);
  });

  it('seeds one HR/MANAGER/EMPLOYEE user directly (register only ever creates an ADMIN founder)', async () => {
    const hashedPassword = await bcrypt.hash(password, 4);
    for (const [role, email] of [
      [Role.HR, testEmails.hr],
      [Role.MANAGER, testEmails.manager],
      [Role.EMPLOYEE, testEmails.employee],
    ] as const) {
      await prisma.user.create({
        data: {
          organizationId,
          employeeId: `E2E-${role}`,
          email,
          password: hashedPassword,
          name: `E2E ${role}`,
          role,
          mustChangePassword: false,
        },
      });
    }
  });

  let adminCookies: string[];
  let adminAccessToken: string;
  let firstRefreshToken: string;

  it('logs in and delivers both tokens: httpOnly cookie AND response body', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: testEmails.admin, password })
      .expect(201);

    const body = res.body as AuthBody;
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.expiresIn).toBe(900);
    expect(body.user.role).toBe('ADMIN');

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith('refresh_token='))).toBe(true);
    expect(setCookie.some((c) => c.includes('HttpOnly'))).toBe(true);

    adminCookies = setCookie;
    adminAccessToken = body.accessToken;
    firstRefreshToken = body.refreshToken;
  });

  it('rejects requests to a protected endpoint with no token', async () => {
    await request(app.getHttpServer()).get('/organizations/me').expect(401);
  });

  it('rejects requests with a garbage token', async () => {
    await request(app.getHttpServer())
      .get('/organizations/me')
      .set('Authorization', 'Bearer garbage.invalid.token')
      .expect(401);
  });

  it('allows the ADMIN founder through the RBAC proof endpoint', async () => {
    const res = await request(app.getHttpServer())
      .get('/organizations/me')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect((res.body as { id: string }).id).toBe(organizationId);
  });

  it.each([
    [testEmails.hr, 200],
    [testEmails.manager, 403],
    [testEmails.employee, 403],
  ])(
    'RBAC on GET /organizations/me: %s -> %i',
    async (email, expectedStatus) => {
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(201);
      const { accessToken } = loginRes.body as AuthBody;
      await request(app.getHttpServer())
        .get('/organizations/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(expectedStatus);
    },
  );

  it('refresh (via cookie) rotates the token and issues a new access token', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', adminCookies)
      .expect(201);

    const body = res.body as AuthBody;
    expect(body.accessToken).not.toBe(adminAccessToken);
    expect(body.refreshToken).not.toBe(firstRefreshToken);

    // The new access token actually works against a protected route.
    await request(app.getHttpServer())
      .get('/organizations/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);
  });

  it('the rotated-away refresh token is now revoked and cannot be reused', async () => {
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstRefreshToken })
      .expect(401);
  });

  it('logout revokes the refresh token server-side, not just clears the cookie', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: testEmails.admin, password })
      .expect(201);
    const { refreshToken } = loginRes.body as { refreshToken: string };

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken })
      .expect(201);

    // Replaying the exact revoked token (not relying on cookie-absence)
    // proves this is a real server-side revocation.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });

  it('supports the mobile no-cookie-jar path: refresh works from the body alone', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: testEmails.admin, password })
      .expect(201);
    const { refreshToken } = loginRes.body as { refreshToken: string };

    // Deliberately not attaching any cookie here.
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(201);
    expect((res.body as AuthBody).accessToken).toEqual(expect.any(String));
  });
});
