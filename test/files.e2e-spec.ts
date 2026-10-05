import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
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
    // Same helmet settings as main.ts, so the framing test below proves the file route strips the
    // X-Frame-Options: SAMEORIGIN helmet would otherwise send.
    app.use(
      helmet({
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
      }),
    );
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

  it('branding accepts JPEG as well as PNG, and rejects SVG/WEBP/GIF with a JPEG-and-PNG message', async () => {
    const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
    const branding = (name: string, type: string, body: Buffer | string) =>
      request(app.getHttpServer())
        .post('/files/upload/branding')
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', Buffer.isBuffer(body) ? body : Buffer.from(body), {
          filename: name,
          contentType: type,
        });
    await branding('logo.jpg', 'image/jpeg', JPEG).expect(201);
    await branding('logo.jpeg', 'image/jpeg', JPEG).expect(201);

    for (const [name, type, body] of [
      [
        'logo.svg',
        'image/svg+xml',
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      ],
      ['logo.webp', 'image/webp', 'RIFF\x24\x00\x00\x00WEBPVP8 '],
      ['logo.gif', 'image/gif', 'GIF89a\x00\x00'],
    ] as const) {
      const res = await branding(name, type, body).expect(400);
      expect((res.body as { message: string }).message).toContain(
        'JPEG and PNG images',
      );
    }
    // Real bytes must be PNG/JPEG and agree with the extension and declared type.
    await branding('fake.png', 'image/png', 'GIF89a\x00\x00').expect(400);
    await branding('mismatch.png', 'image/png', JPEG).expect(400);
    await branding('mismatch.jpg', 'image/jpeg', PNG).expect(400);
  });

  it('profile photos follow the same JPEG/PNG-only rule', async () => {
    const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
    const photo = (name: string, type: string, body: Buffer | string) =>
      request(app.getHttpServer())
        .post('/files/upload/profile-photos')
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', Buffer.isBuffer(body) ? body : Buffer.from(body), {
          filename: name,
          contentType: type,
        });
    await photo('me.jpg', 'image/jpeg', JPEG).expect(201);
    await photo('me.png', 'image/png', PNG).expect(201);
    await photo('me.webp', 'image/webp', 'RIFF\x24\x00\x00\x00WEBPVP8 ').expect(
      400,
    );
    await photo('me.svg', 'image/svg+xml', '<svg/>').expect(400);
  });

  it('an upload over the size limit is refused with a message that states the limit (413)', async () => {
    // Profile photos are limited to 5 MB: a 6 MB JPEG-looking file is over it.
    const JPEG_HEAD = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000',
      'hex',
    );
    const big = Buffer.concat([JPEG_HEAD, Buffer.alloc(6 * 1024 * 1024)]);
    const res = await request(app.getHttpServer())
      .post('/files/upload/profile-photos')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', big, { filename: 'huge.jpg', contentType: 'image/jpeg' })
      .expect(413);
    const message = (res.body as { message: string }).message;
    expect(message).toMatch(/too large/i);
    expect(message).toContain('5 MB'); // not just "File too large"
  });

  it('serves the uploaded file via the signed url, without any auth header', async () => {
    const res = await request(app.getHttpServer()).get(uploadedUrl).expect(200);
    expect((res.body as Buffer).equals(PNG)).toBe(true);
  });

  it('serves files inline and embeddable (no X-Frame-Options), so the in-app viewer can frame them from another origin', async () => {
    const res = await request(app.getHttpServer()).get(uploadedUrl).expect(200);
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
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
