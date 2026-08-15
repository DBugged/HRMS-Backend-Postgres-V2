import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

interface ErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
  path: string;
  timestamp: string;
}

// AllExceptionsFilter is registered as an APP_FILTER provider in
// AppModule itself (not in main.ts's bootstrap()), so it's live in every
// e2e spec's test app the same way APP_GUARD is — no per-spec wiring
// needed, unlike helmet/CORS which only exist in the real main.ts.
describe('Global error envelope (e2e)', () => {
  let app: INestApplication<App>;

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('a 401 (no token) comes back in the standard envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/organizations/me')
      .expect(401);
    const body = res.body as ErrorBody;
    expect(body.statusCode).toBe(401);
    expect(typeof body.message).toBe('string');
    expect(body.error).toEqual(expect.any(String));
    expect(body.path).toBe('/organizations/me');
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('a 404 (unknown route) comes back in the same envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/this-route-does-not-exist')
      .expect(404);
    const body = res.body as ErrorBody;
    expect(body.statusCode).toBe(404);
    expect(body.path).toBe('/this-route-does-not-exist');
    expect(body.timestamp).toEqual(expect.any(String));
  });

  it('a 400 validation failure preserves the class-validator message array', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'not-an-email' }) // missing password, invalid email
      .expect(400);
    const body = res.body as ErrorBody;
    expect(body.statusCode).toBe(400);
    expect(Array.isArray(body.message)).toBe(true);
    expect(body.path).toBe('/auth/login');
  });
});
