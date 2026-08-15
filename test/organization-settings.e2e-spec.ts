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
interface EmployeeCreateBody {
  employee: { id: string };
  generatedPassword: string;
}
interface OrgSettingsBody {
  isInitialized: boolean;
  setupStep: number;
  canEdit?: boolean;
  companyName: string | null;
  legalName?: string | null;
  gstin: string | null;
  pan?: string | null;
  signatories?: unknown[];
  sealUrl?: string | null;
  customEmployeeTypes?: unknown[];
  initializedAt?: string | null;
}
interface PreviewBody {
  preview: string;
}
interface ErrorBody {
  message: string;
}

const PASSWORD = 'TestPass123!';

describe('Organization Settings / Setup Wizard (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
  let organizationId: string;

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
      organizationName: 'Org Settings E2E Org',
      name: 'Founder',
      email: 'orgset-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'orgset-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'orgset-e2e-admin@example.test' },
    });
    organizationId = admin.organizationId;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'orgset-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'orgset-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'orgset-e2e-emp@example.test' });
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'orgset-e2e-emp@example.test',
        password: (empCreate.body as EmployeeCreateBody).generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('a brand-new org starts uninitialized, at setup step 1', async () => {
    const res = await request(app.getHttpServer())
      .get('/organizations/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as OrgSettingsBody;
    expect(body.isInitialized).toBe(false);
    expect(body.setupStep).toBe(1);
    expect(body.canEdit).toBe(true);
  });

  it('HR and EMPLOYEE get 403 on the full settings read (ADMIN only)', async () => {
    await request(app.getHttpServer())
      .get('/organizations/settings')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/organizations/settings')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('public branding is readable by any authenticated role and leaks nothing else', async () => {
    const res = await request(app.getHttpServer())
      .get('/organizations/settings/public')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(res.body).toEqual({
      isInitialized: false,
      companyName: null,
      tagline: null,
      companyLogoUrl: null,
      faviconUrl: null,
      primaryColor: '#5546e0',
      secondaryColor: '#14161d',
      enableWFH: true,
    });
  });

  it('EMPLOYEE gets 403 updating a section', async () => {
    await request(app.getHttpServer())
      .patch('/organizations/settings/profile')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ companyName: 'Nope Inc' })
      .expect(403);
  });

  it('rejects an unknown section', async () => {
    await request(app.getHttpServer())
      .patch('/organizations/settings/not-a-real-section')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ x: 1 })
      .expect(400);
  });

  it('updates the profile section and advances setupStep, ignoring non-whitelisted fields', async () => {
    const res = await request(app.getHttpServer())
      .patch('/organizations/settings/profile')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyName: 'Acme Corp',
        legalName: 'Acme Corporation Pvt Ltd',
        // Not in the `profile` section whitelist — must be silently ignored.
        gstin: '29ABCDE1234F1Z5',
        setupStep: 2,
      })
      .expect(200);
    const body = res.body as OrgSettingsBody;
    expect(body.companyName).toBe('Acme Corp');
    expect(body.legalName).toBe('Acme Corporation Pvt Ltd');
    expect(body.gstin).toBeNull();
    expect(body.setupStep).toBe(2);
  });

  it('rejects a malformed GSTIN in the registration section', async () => {
    await request(app.getHttpServer())
      .patch('/organizations/settings/registration')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ gstin: 'not-a-real-gstin' })
      .expect(400);
  });

  it('accepts a valid registration section', async () => {
    const res = await request(app.getHttpServer())
      .patch('/organizations/settings/registration')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ gstin: '29ABCDE1234F1Z5', pan: 'ABCDE1234F' })
      .expect(200);
    const body = res.body as OrgSettingsBody;
    expect(body.gstin).toBe('29ABCDE1234F1Z5');
    expect(body.pan).toBe('ABCDE1234F');
  });

  it('rejects a malformed IFSC in the banking section', async () => {
    await request(app.getHttpServer())
      .patch('/organizations/settings/banking')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ banking: { ifscCode: 'bad' } })
      .expect(400);
  });

  it('accepts the contact section, satisfying the fields required for complete-setup', async () => {
    await request(app.getHttpServer())
      .patch('/organizations/settings/contact')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        registeredAddress: '123 Main St',
        city: 'Bengaluru',
        state: 'Karnataka',
        country: 'India',
        pincode: '560001',
        phone: '+91 98765 43210',
        contactEmail: 'hr@acme.test',
      })
      .expect(200);
  });

  it('replaces the full signatories array and seal on the signatory section', async () => {
    const res = await request(app.getHttpServer())
      .patch('/organizations/settings/signatory')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        signatories: [
          {
            id: '1',
            name: 'Jane Founder',
            designation: 'CEO',
            isPrimary: true,
          },
        ],
        sealUrl: 'org-id/branding/seal.png',
      })
      .expect(200);
    const body = res.body as OrgSettingsBody;
    expect(body.signatories).toHaveLength(1);
    // Signed into a /files/<token> URL, not the raw relative key.
    expect(body.sealUrl).toMatch(/^\/files\//);
  });

  it('replaces custom employee types via the employeeTypes section', async () => {
    const res = await request(app.getHttpServer())
      .patch('/organizations/settings/employeeTypes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customEmployeeTypes: [{ value: 'gig_worker', label: 'Gig Worker' }],
      })
      .expect(200);
    expect((res.body as OrgSettingsBody).customEmployeeTypes).toEqual([
      { value: 'gig_worker', label: 'Gig Worker' },
    ]);
  });

  it('previews the next document number without consuming the counter', async () => {
    const first = await request(app.getHttpServer())
      .get('/organizations/settings/document-numbering/payslip/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const second = await request(app.getHttpServer())
      .get('/organizations/settings/document-numbering/payslip/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const firstBody = first.body as PreviewBody;
    const secondBody = second.body as PreviewBody;
    expect(firstBody.preview).toBe(secondBody.preview);
    expect(firstBody.preview).toMatch(/^PS-\d{6}-0001$/);
  });

  it('404s previewing an unknown document type', async () => {
    await request(app.getHttpServer())
      .get('/organizations/settings/document-numbering/not-a-type/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('complete-setup fails while required fields are still missing', async () => {
    // Reset just the one remaining required field this test needs to be
    // missing (mobile isn't required, but we can null out `phone` to
    // re-trigger the failure path deterministically).
    await prisma.organization.update({
      where: { id: organizationId },
      data: { phone: null },
    });
    const res = await request(app.getHttpServer())
      .post('/organizations/settings/complete-setup')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect((res.body as ErrorBody).message).toMatch(/phone/);
  });

  it('complete-setup succeeds once all required fields are present, and sets isInitialized', async () => {
    await request(app.getHttpServer())
      .patch('/organizations/settings/contact')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '+91 98765 43210' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/organizations/settings/complete-setup')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    const body = res.body as OrgSettingsBody;
    expect(body.isInitialized).toBe(true);
    expect(body.initializedAt).not.toBeNull();

    const publicView = await request(app.getHttpServer())
      .get('/organizations/settings/public')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((publicView.body as OrgSettingsBody).isInitialized).toBe(true);
  });

  it('reset-setup flips isInitialized back to false without clearing data', async () => {
    const res = await request(app.getHttpServer())
      .post('/organizations/settings/reset-setup')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    const body = res.body as OrgSettingsBody;
    expect(body.isInitialized).toBe(false);
    expect(body.companyName).toBe('Acme Corp');
  });
});
