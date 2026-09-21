import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

describe('Public email logo (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let orgId: string;
  let otherOrgId: string;
  const dir = () => path.join(process.cwd(), 'uploads', orgId, 'branding');

  const setLogo = (id: string, key: string | null) =>
    prisma.organization.update({ where: { id }, data: { emailLogoUrl: key } });

  beforeAll(async () => {
    const m: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const mk = async (email: string, name: string) => {
      await request(app.getHttpServer()).post('/auth/register').send({
        organizationName: name,
        name: 'Founder',
        email,
        password: 'TestPass123!',
      });
      const u = await prisma.user.findFirst({ where: { email } });
      return u!.organizationId;
    };
    orgId = await mk('pub-brand-a@example.test', 'Pub Brand A');
    otherOrgId = await mk('pub-brand-b@example.test', 'Pub Brand B');
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), 'logo.png'), PNG);
    fs.writeFileSync(path.join(dir(), 'logo.svg'), '<svg/>');
  });

  afterAll(async () => {
    fs.rmSync(path.join(process.cwd(), 'uploads', orgId), {
      recursive: true,
      force: true,
    });
    await app.close();
  });

  it('serves the PNG unauthenticated with safe, cacheable headers', async () => {
    await setLogo(orgId, `${orgId}/branding/logo.png`);
    const res = await request(app.getHttpServer())
      .get(`/public/branding/${orgId}/email-logo?v=abc`)
      .expect(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('404s for an SVG logo, no logo, unknown org, non-UUID id', async () => {
    await setLogo(orgId, `${orgId}/branding/logo.svg`);
    await request(app.getHttpServer())
      .get(`/public/branding/${orgId}/email-logo`)
      .expect(404);
    await setLogo(orgId, null);
    await request(app.getHttpServer())
      .get(`/public/branding/${orgId}/email-logo`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/public/branding/${UNKNOWN}/email-logo`)
      .expect(404);
    await request(app.getHttpServer())
      .get('/public/branding/not-a-uuid/email-logo')
      .expect(404);
  });

  it("404s when the stored key points into another org's folder or traverses", async () => {
    await setLogo(otherOrgId, `${orgId}/branding/logo.png`);
    await request(app.getHttpServer())
      .get(`/public/branding/${otherOrgId}/email-logo`)
      .expect(404);
    await setLogo(otherOrgId, `${otherOrgId}/../${orgId}/branding/logo.png`);
    await request(app.getHttpServer())
      .get(`/public/branding/${otherOrgId}/email-logo`)
      .expect(404);
  });
});
