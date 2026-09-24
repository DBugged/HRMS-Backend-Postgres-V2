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
import { hashToken, REFRESH_REUSE_GRACE_MS } from '../src/auth/auth.service';

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

  it('rejects change-password with no token', async () => {
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .send({ currentPassword: password, newPassword: 'NewPass123!' })
      .expect(401);
  });

  it('change-password rejects an incorrect current password', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: testEmails.employee, password })
      .expect(201);
    const { accessToken } = loginRes.body as AuthBody;

    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'WrongPassword!', newPassword: 'NewPass123!' })
      .expect(400);
  });

  it('change-password rejects a weak new password with a 400 listing what is missing', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: testEmails.employee, password })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${(loginRes.body as AuthBody).accessToken}`)
      .send({ currentPassword: password, newPassword: 'weakpass' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('uppercase');
  });

  it('change-password succeeds, clears mustChangePassword, and the new password logs in', async () => {
    // Seeded with mustChangePassword: false in the earlier seeding step —
    // flip it on here to prove this endpoint is the one that clears it,
    // same as the mandatory first-login flow relies on.
    await prisma.user.updateMany({
      where: { organizationId, email: testEmails.employee },
      data: { mustChangePassword: true },
    });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: testEmails.employee, password })
      .expect(201);
    const { accessToken } = loginRes.body as AuthBody;
    expect(
      (loginRes.body as AuthBody & { user: { mustChangePassword: boolean } })
        .user.mustChangePassword,
    ).toBe(true);

    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: password, newPassword: 'NewPass123!' })
      .expect(201);

    // Old password no longer works.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: testEmails.employee, password })
      .expect(401);

    // New password works and mustChangePassword is now false.
    const relogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: testEmails.employee, password: 'NewPass123!' })
      .expect(201);
    expect(
      (relogin.body as AuthBody & { user: { mustChangePassword: boolean } })
        .user.mustChangePassword,
    ).toBe(false);
  });

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

  describe('refresh-token rotation races and reuse detection', () => {
    const loginAdmin = async () =>
      (
        (
          await request(app.getHttpServer())
            .post('/auth/login')
            .send({ email: testEmails.admin, password })
            .expect(201)
        ).body as AuthBody
      ).refreshToken;
    const refresh = (refreshToken: string) =>
      request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken });

    // Regression: the revokedAt check and the (unconditional) revoke ran
    // around issuance, so 5 concurrent refreshes with one token minted 2+
    // independent new pairs.
    it('concurrent refreshes with one token issue exactly one new pair', async () => {
      const token = await loginAdmin();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => refresh(token)),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 401)).toHaveLength(4);

      const presented = await prisma.refreshToken.findFirstOrThrow({
        where: { tokenHash: hashToken(token) },
      });
      const winner = results.find((r) => r.status === 201)!.body as AuthBody;
      expect(presented.revokedAt).not.toBeNull();
      expect(presented.replacedByTokenHash).toBe(
        hashToken(winner.refreshToken),
      );
    });

    // Regression: replaying an already-rotated token didn't revoke the
    // tokens descended from it, so a thief kept a live session.
    it('replaying a rotated token (outside the grace window) revokes its whole family', async () => {
      const a = await loginAdmin();
      const b = ((await refresh(a).expect(201)).body as AuthBody).refreshToken;
      const c = ((await refresh(b).expect(201)).body as AuthBody).refreshToken;

      // Age the rotation of A past the benign-race grace window.
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(a) },
        data: { revokedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1) },
      });

      await refresh(a).expect(401);

      const live = await prisma.refreshToken.findFirstOrThrow({
        where: { tokenHash: hashToken(c) },
      });
      expect(live.revokedAt).not.toBeNull();
      await refresh(c).expect(401);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'REFRESH_TOKEN_REUSE_DETECTED' },
      });
      expect(audit).not.toBeNull();
    });

    it('a replay within the grace window (concurrent tabs) is refused but does not kill the new session', async () => {
      const a = await loginAdmin();
      const b = ((await refresh(a).expect(201)).body as AuthBody).refreshToken;
      await refresh(a).expect(401);
      await refresh(b).expect(201);
    });
  });

  // Regression (F7 / F9d): emails were stored/compared case-sensitively, so
  // `A@X.test` and `a@x.test` were two accounts and mixed-case login failed;
  // a whitespace-only founder name was accepted.
  describe('register/login input normalization', () => {
    it('lowercases the registration email, rejects a case-only duplicate, and logs in with any casing', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          organizationName: 'Case Org',
          name: 'Case Founder',
          email: ' E2E-Case-Founder@Example.TEST ',
          password,
        })
        .expect(201);
      const user = await prisma.user.findFirst({
        where: { email: 'e2e-case-founder@example.test' },
      });
      expect(user).not.toBeNull();

      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          organizationName: 'Case Org Twin',
          name: 'Case Twin',
          email: 'e2e-case-founder@example.test',
          password,
        })
        .expect(409);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'E2E-CASE-FOUNDER@example.test', password })
        .expect(201);
    });

    it('concurrent registrations differing only by case create one account', async () => {
      const results = await Promise.all(
        ['E2E-Race@Example.test', 'e2e-race@example.test'].map((email, i) =>
          request(app.getHttpServer())
            .post('/auth/register')
            .send({
              organizationName: `Race Org ${i}`,
              name: 'Racer',
              email,
              password,
            }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(
        await prisma.user.count({
          where: {
            email: { equals: 'e2e-race@example.test', mode: 'insensitive' },
          },
        }),
      ).toBe(1);
    });

    it('rejects a whitespace-only founder name', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          organizationName: 'Blank Name Org',
          name: '   ',
          email: 'e2e-blank-name@example.test',
          password,
        })
        .expect(400);
    });
  });
});
