import * as path from 'path';
import * as fs from 'fs';
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
interface UploadBody {
  relativeKey: string;
  url: string;
}

const PASSWORD = 'TestPass123!';

// Real file signatures: uploads are now checked against their actual bytes, not just the declared type.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PDF = Buffer.from('%PDF-1.4 fake pdf', 'ascii');

describe('Files (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;

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
      organizationName: 'Files E2E Org',
      name: 'Founder',
      email: 'files-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'files-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('rejects an unauthenticated upload', async () => {
    await request(app.getHttpServer())
      .post('/files/upload/branding')
      .attach('file', PNG, {
        filename: 'logo.png',
        contentType: 'image/png',
      })
      .expect(401);
  });

  it('rejects a mime type not allowed for the category', async () => {
    await request(app.getHttpServer())
      .post('/files/upload/branding')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('not an image'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(400);
  });

  let uploadedUrl: string;
  let uploadedRelativeKey: string;

  it('uploads a valid branding image and returns a relativeKey + signed url', async () => {
    const res = await request(app.getHttpServer())
      .post('/files/upload/branding')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', PNG, {
        filename: 'logo.png',
        contentType: 'image/png',
      })
      .expect(201);
    const body = res.body as UploadBody;
    uploadedUrl = body.url;
    uploadedRelativeKey = body.relativeKey;
    expect(uploadedRelativeKey).toMatch(/\/branding\/.+\.png$/);
    expect(uploadedUrl).toMatch(/^\/files\/.+/);
  });

  it('serves the uploaded file via the signed url, without any auth header', async () => {
    const res = await request(app.getHttpServer()).get(uploadedUrl).expect(200);
    expect((res.body as Buffer).equals(PNG)).toBe(true);
  });

  it('404s on a tampered token', async () => {
    const tampered =
      uploadedUrl.slice(0, -1) + (uploadedUrl.endsWith('a') ? 'b' : 'a');
    await request(app.getHttpServer()).get(tampered).expect(404);
  });

  it('404s on a syntactically invalid token', async () => {
    await request(app.getHttpServer())
      .get('/files/not-a-real-token')
      .expect(404);
  });

  it('a document upload accepts PDFs', async () => {
    const res = await request(app.getHttpServer())
      .post('/files/upload/documents')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', PDF, {
        filename: 'policy.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    expect((res.body as UploadBody).relativeKey).toMatch(
      /\/documents\/.+\.pdf$/,
    );
  });

  it('a selfie upload rejects a PDF (image-only category)', async () => {
    await request(app.getHttpServer())
      .post('/files/upload/selfies')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', PDF, {
        filename: 'selfie.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
  });

  it('rejects HTML / PHP / SVG / empty files even when labelled as an allowed type', async () => {
    const send = (name: string, type: string, body: Buffer | string) =>
      request(app.getHttpServer())
        .post('/files/upload/documents')
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', Buffer.isBuffer(body) ? body : Buffer.from(body), {
          filename: name,
          contentType: type,
        });
    // scriptable extension, image mimetype
    await send('evil.html', 'image/png', '<script>alert(1)</script>').expect(
      400,
    );
    await send('shell.php', 'image/png', '<?php echo 1; ?>').expect(400);
    await send(
      'vector.svg',
      'image/svg+xml',
      '<svg onload="alert(1)"/>',
    ).expect(400);
    // right extension, wrong bytes
    await send(
      'fake.png',
      'image/png',
      '<html><script>alert(1)</script></html>',
    ).expect(400);
    await send('fake.pdf', 'application/pdf', 'not really a pdf').expect(400);
    // empty
    await send('empty.pdf', 'application/pdf', Buffer.alloc(0)).expect(400);
  });

  it('a rejected upload leaves no file behind on disk', async () => {
    const dir = path.join(__dirname, '../uploads');
    const count = () => {
      const walk = (d: string): number =>
        fs.existsSync(d)
          ? fs
              .readdirSync(d, { withFileTypes: true })
              .reduce(
                (n, e) =>
                  n + (e.isDirectory() ? walk(path.join(d, e.name)) : 1),
                0,
              )
          : 0;
      return walk(dir);
    };
    const before = count();
    await request(app.getHttpServer())
      .post('/files/upload/documents')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('<html></html>'), {
        filename: 'x.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(count()).toBe(before);
  });
});
