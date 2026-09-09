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
import { hashToken } from '../src/auth/auth.service';
import { LOGIN_MAX_FAILED_ATTEMPTS } from '../src/auth/auth.constants';

const PASSWORD = 'TestPass123!';
const EMAIL = 'lockout-e2e-admin@example.test';

// Covers the per-account brute-force lockout. The @Throttle() on /auth/login
// is per-IP, so a distributed attack on one account never trips it; these
// tests exercise the account-side counter instead.
describe('Login lockout (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let userId: string;

  const readUser = () =>
    prisma.user.findFirstOrThrow({ where: { email: EMAIL } });

  // Walk the counter to one short of the threshold rather than issuing
  // LOGIN_MAX_FAILED_ATTEMPTS real requests — the point under test is the
  // transition, and each attempt costs a bcrypt round.
  const primeToOneBeforeLockout = () =>
    prisma.user.updateMany({
      where: { id: userId },
      data: {
        failedLoginAttempts: LOGIN_MAX_FAILED_ATTEMPTS - 1,
        lockedUntil: null,
      },
    });

  const login = (password: string) =>
    request(app.getHttpServer()).post('/auth/login').send({
      email: EMAIL,
      password,
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
      organizationName: 'Login Lockout E2E Org',
      name: 'Founder',
      email: EMAIL,
      password: PASSWORD,
    });
    userId = (await readUser()).id;
  });

  afterEach(async () => {
    await prisma.user.updateMany({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('counts failed attempts on the account row', async () => {
    await login('WrongPassword1!').expect(401);
    expect((await readUser()).failedLoginAttempts).toBe(1);
  });

  it('locks the account once the threshold is reached', async () => {
    await primeToOneBeforeLockout();
    await login('WrongPassword1!').expect(401);

    const user = await readUser();
    expect(user.lockedUntil).not.toBeNull();
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // Counter is reset alongside the lock so the account gets a fresh
    // window when the lock expires instead of re-locking immediately.
    expect(user.failedLoginAttempts).toBe(0);
  });

  it('rejects the CORRECT password while the account is locked', async () => {
    await primeToOneBeforeLockout();
    await login('WrongPassword1!').expect(401);
    await login(PASSWORD).expect(401);
  });

  it('does not extend the lock on further attempts', async () => {
    await primeToOneBeforeLockout();
    await login('WrongPassword1!').expect(401);
    const lockedUntil = (await readUser()).lockedUntil!;

    await login('WrongPassword1!').expect(401);
    await login(PASSWORD).expect(401);

    expect((await readUser()).lockedUntil!.getTime()).toBe(
      lockedUntil.getTime(),
    );
  });

  it('lets the account back in once the lock expires, and clears the counters', async () => {
    await prisma.user.updateMany({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() - 60_000) },
    });
    await login(PASSWORD).expect(201);

    const user = await readUser();
    expect(user.lockedUntil).toBeNull();
    expect(user.failedLoginAttempts).toBe(0);
  });

  it('a successful login clears a partial failure count', async () => {
    await prisma.user.updateMany({
      where: { id: userId },
      data: { failedLoginAttempts: 3 },
    });
    await login(PASSWORD).expect(201);
    expect((await readUser()).failedLoginAttempts).toBe(0);
  });

  it('completing a password reset clears the lock (the self-service way out)', async () => {
    const rawToken = 'lockout-e2e-reset-token';
    await prisma.user.updateMany({
      where: { id: userId },
      data: {
        lockedUntil: new Date(Date.now() + 60 * 60_000),
        resetPasswordToken: hashToken(rawToken),
        resetPasswordExpires: new Date(Date.now() + 30 * 60_000),
      },
    });

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: rawToken, password: 'AfterLockout123!' })
      .expect(201);

    const user = await readUser();
    expect(user.lockedUntil).toBeNull();
    expect(user.failedLoginAttempts).toBe(0);

    await login('AfterLockout123!').expect(201);
  });
});
