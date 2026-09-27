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

const PASSWORD = 'TestPass123!';

// .env.test has no ANTHROPIC_API_KEY set, so every test here exercises the
// "not configured" graceful-degradation path (same convention as
// EmailService's SMTP/Resend DRY RUN) rather than a real API call.
describe('Policy Assistant (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let employeeToken: string;

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
      organizationName: 'Policy Assistant E2E Org',
      name: 'Founder',
      email: 'policy-asst-e2e-admin@example.test',
      password: PASSWORD,
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'policy-asst-e2e-admin@example.test', password: PASSWORD });
    employeeToken = (login.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('degrades gracefully with a clear message when ANTHROPIC_API_KEY is not configured', async () => {
    const res = await request(app.getHttpServer())
      .post('/policy-assistant/ask')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ question: 'How many casual leaves do I get?' })
      .expect(201);
    const body = res.body as { answer: string; grounded: boolean; sources: string[] };
    expect(body.grounded).toBe(false);
    expect(body.sources).toEqual([]);
    expect(body.answer).toMatch(/ask HR/i);
  });

  it('400s on an empty question', async () => {
    await request(app.getHttpServer())
      .post('/policy-assistant/ask')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ question: '' })
      .expect(400);
  });

  it('401s without a token', async () => {
    await request(app.getHttpServer())
      .post('/policy-assistant/ask')
      .send({ question: 'What is the leave policy?' })
      .expect(401);
  });
});
