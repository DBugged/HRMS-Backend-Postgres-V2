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

interface AuthBody {
  accessToken: string;
}
interface MessageBody {
  message: string;
}

const PASSWORD = 'TestPass123!';

describe('Password Reset (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

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
      organizationName: 'Password Reset E2E Org',
      name: 'Founder',
      email: 'pwreset-e2e-admin@example.test',
      password: PASSWORD,
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('forgot-password returns the same generic message for an existing email', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'pwreset-e2e-admin@example.test' })
      .expect(201);
    expect((res.body as MessageBody).message).toBe(
      'If that email exists, a reset link has been sent.',
    );
  });

  it("forgot-password returns the identical message for an email that doesn't exist (non-enumerable)", async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'nobody-here@example.test' })
      .expect(201);
    expect((res.body as MessageBody).message).toBe(
      'If that email exists, a reset link has been sent.',
    );
  });

  it('forgot-password sets a hashed, expiring reset token on the user row', async () => {
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'pwreset-e2e-admin@example.test' })
      .expect(201);
    const user = await prisma.user.findFirstOrThrow({
      where: { email: 'pwreset-e2e-admin@example.test' },
    });
    expect(user.resetPasswordToken).not.toBeNull();
    expect(user.resetPasswordExpires).not.toBeNull();
    expect(user.resetPasswordExpires!.getTime()).toBeGreaterThan(Date.now());
  });

  it('reset-password rejects an invalid token with one generic error', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: 'not-a-real-token', password: 'NewPassword123!' })
      .expect(400);
    expect((res.body as MessageBody).message).toBe(
      'Reset link is invalid or has expired.',
    );
  });

  it('reset-password rejects an expired token with the same generic error', async () => {
    const rawToken = 'expired-token-raw-value';
    await prisma.user.updateMany({
      where: { email: 'pwreset-e2e-admin@example.test' },
      data: {
        resetPasswordToken: hashToken(rawToken),
        resetPasswordExpires: new Date(Date.now() - 1000),
      },
    });
    const res = await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: rawToken, password: 'NewPassword123!' })
      .expect(400);
    expect((res.body as MessageBody).message).toBe(
      'Reset link is invalid or has expired.',
    );
  });

  it('reset-password succeeds with a valid token: updates password, clears the token, allows login with the new password, and rejects the old one', async () => {
    const rawToken = 'valid-token-raw-value';
    await prisma.user.updateMany({
      where: { email: 'pwreset-e2e-admin@example.test' },
      data: {
        resetPasswordToken: hashToken(rawToken),
        resetPasswordExpires: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const res = await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: rawToken, password: 'BrandNewPassword123!' })
      .expect(201);
    expect((res.body as MessageBody).message).toBe(
      'Password updated successfully. Please log in.',
    );

    const user = await prisma.user.findFirstOrThrow({
      where: { email: 'pwreset-e2e-admin@example.test' },
    });
    expect(user.resetPasswordToken).toBeNull();
    expect(user.resetPasswordExpires).toBeNull();
    expect(user.mustChangePassword).toBe(false);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'pwreset-e2e-admin@example.test', password: PASSWORD })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'pwreset-e2e-admin@example.test',
        password: 'BrandNewPassword123!',
      })
      .expect(201);
  });

  it('the same reset token cannot be reused a second time', async () => {
    const rawToken = 'single-use-token';
    await prisma.user.updateMany({
      where: { email: 'pwreset-e2e-admin@example.test' },
      data: {
        resetPasswordToken: hashToken(rawToken),
        resetPasswordExpires: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: rawToken, password: 'AnotherPassword123!' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: rawToken, password: 'YetAnotherPassword123!' })
      .expect(400);
  });

  it('resetting the password revokes existing refresh tokens', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'pwreset-e2e-admin@example.test',
        password: 'AnotherPassword123!',
      })
      .expect(201);
    const { accessToken } = login.body as AuthBody;
    void accessToken;

    const user = await prisma.user.findFirstOrThrow({
      where: { email: 'pwreset-e2e-admin@example.test' },
    });
    const activeTokensBefore = await prisma.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(activeTokensBefore).toBeGreaterThan(0);

    const rawToken = 'revoke-sessions-token';
    await prisma.user.updateMany({
      where: { id: user.id },
      data: {
        resetPasswordToken: hashToken(rawToken),
        resetPasswordExpires: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: rawToken, password: 'FinalPassword123!' })
      .expect(201);

    const activeTokensAfter = await prisma.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(activeTokensAfter).toBe(0);
  });
});
