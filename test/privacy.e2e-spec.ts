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
import { decryptPersonalData } from '../src/common/personal-data-crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrivacyService } from '../src/privacy/privacy.service';

// Dummy data only. Cleanup TRUNCATEs the test DB (never the dev DB) and removes files this suite created.

interface AuthBody {
  accessToken: string;
}
const PASSWORD = 'TestPass123!';
const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');

describe('Data Privacy & Protection (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let orgId: string;

  let adminToken: string;
  let hrToken: string;
  let e1Token: string;
  let e2Token: string;
  let e3Token: string;
  let e1Id: string;
  let e2Id: string;
  let e3Id: string;
  const createdFiles: string[] = [];

  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function makeUser(
    email: string,
    name: string,
    role?: 'HR' | 'EMPLOYEE',
  ) {
    const create = await http()
      .post('/employees')
      .set(auth(adminToken))
      .send({ name, email, ...(role && { role }) })
      .expect(201);
    const body = create.body as {
      employee: { id: string };
      generatedPassword: string;
    };
    const login = await http()
      .post('/auth/login')
      .send({ email, password: body.generatedPassword });
    return {
      id: body.employee.id,
      token: (login.body as AuthBody).accessToken,
    };
  }

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

    await http().post('/auth/register').send({
      organizationName: 'Privacy E2E Org',
      name: 'Founder',
      email: 'privacy-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await http()
      .post('/auth/login')
      .send({ email: 'privacy-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hr = await makeUser('privacy-e2e-hr@example.test', 'HR Person', 'HR');
    hrToken = hr.token;
    const e1 = await makeUser('privacy-e2e-e1@example.test', 'Employee One');
    const e2 = await makeUser('privacy-e2e-e2@example.test', 'Employee Two');
    const e3 = await makeUser('privacy-e2e-e3@example.test', 'Employee Three');
    e1Token = e1.token;
    e1Id = e1.id;
    e2Token = e2.token;
    e2Id = e2.id;
    e3Token = e3.token;
    e3Id = e3.id;
    const org = await prisma.user.findFirst({
      where: { id: e1Id },
      select: { organizationId: true },
    });
    orgId = org!.organizationId;

    await prisma.user.update({
      where: { id: e1Id },
      data: {
        contactNumber: '9000000001',
        personalData: {
          panNumber: 'ABCDE1234F',
          bankAccountNo: '123456789012',
          currentAddress: 'Old Address',
          fatherName: 'Dummy Father',
        },
      },
    });
  });

  afterAll(async () => {
    for (const f of createdFiles) fs.rmSync(f, { force: true });
    if (orgId) {
      fs.rmSync(path.join(UPLOAD_ROOT, orgId), {
        recursive: true,
        force: true,
      });
    }
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "privacy_audit_logs", "privacy_settings", "privacy_notice_versions", "consent_records", "data_requests", "data_processors", "data_sharing_records", "breach_incidents", "employee_documents", "document_requirements", "payroll_runs", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  // ---- settings RBAC + defaults ----
  describe('settings', () => {
    it('EMPLOYEE and HR get 403; ADMIN gets seeded defaults', async () => {
      await http().get('/privacy/settings').set(auth(e1Token)).expect(403);
      await http().get('/privacy/settings').set(auth(hrToken)).expect(403);
      await http()
        .put('/privacy/settings')
        .set(auth(e1Token))
        .send({ requestSlaDays: 5 })
        .expect(403);
      const res = await http()
        .get('/privacy/settings')
        .set(auth(adminToken))
        .expect(200);
      const s = res.body as {
        requestSlaDays: number;
        processingPurposes: { key: string; legalBasis: string }[];
        retentionRules: {
          periodMonths: number | null;
          action: string;
          basis: string;
          legalReviewRequired: boolean;
        }[];
        dataCategories: { fields: unknown[] }[];
      };
      expect(s.requestSlaDays).toBe(30);
      expect(s.processingPurposes.map((p) => p.key)).toEqual(
        expect.arrayContaining([
          'onboarding',
          'payroll',
          'statutory_compliance',
          'security_access',
        ]),
      );
      expect(s.retentionRules.length).toBeGreaterThan(0);
      expect(
        s.retentionRules.every(
          (r) =>
            typeof r.periodMonths === 'number' &&
            r.legalReviewRequired &&
            r.basis === 'Suggested default — confirm with legal counsel' &&
            (r.action === 'ARCHIVE' || r.action === 'MANUAL_REVIEW'),
        ),
      ).toBe(true);
      expect(s.dataCategories.every((c) => c.fields.length > 0)).toBe(true);
    });

    it('rejects an invalid legal basis and out-of-range SLA', async () => {
      await http()
        .put('/privacy/settings')
        .set(auth(adminToken))
        .send({
          processingPurposes: [{ key: 'x_y', label: 'X', legalBasis: 'VIBES' }],
        })
        .expect(400);
      await http()
        .put('/privacy/settings')
        .set(auth(adminToken))
        .send({ requestSlaDays: 0 })
        .expect(400);
    });

    it('ADMIN updates officer contact and SLA', async () => {
      const res = await http()
        .put('/privacy/settings')
        .set(auth(adminToken))
        .send({
          privacyOfficerName: 'Dummy Officer',
          privacyOfficerEmail: 'officer@example.test',
          requestSlaDays: 10,
        })
        .expect(200);
      expect((res.body as { requestSlaDays: number }).requestSlaDays).toBe(10);
      const contact = await http()
        .get('/privacy/me/contact')
        .set(auth(e1Token))
        .expect(200);
      expect(
        (contact.body as { privacyOfficerName: string }).privacyOfficerName,
      ).toBe('Dummy Officer');
    });

    it('seeds only system-detected processors on first read', async () => {
      const res = await http()
        .get('/privacy/processors')
        .set(auth(adminToken))
        .expect(200);
      const list = (
        res.body as { data: { service: string; isSystemDetected: boolean }[] }
      ).data;
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((p) => p.isSystemDetected)).toBe(true);
      expect(list.map((p) => p.service)).toEqual(
        expect.arrayContaining(['Email delivery', 'File storage']),
      );
      // deleting one must not bring it back on the next read
      await http()
        .delete(
          `/privacy/processors/${(list[0] as unknown as { id: string }).id}`,
        )
        .set(auth(adminToken))
        .expect(200);
      const again = await http()
        .get('/privacy/processors')
        .set(auth(adminToken))
        .expect(200);
      expect((again.body as { data: unknown[] }).data).toHaveLength(
        list.length - 1,
      );
    });
  });

  // ---- notice versioning ----
  describe('notice versions', () => {
    let draftId: string;

    it('default v1 is a DRAFT template and is not shown to employees; no "compliant" claim', async () => {
      const list = await http()
        .get('/privacy/notices')
        .set(auth(adminToken))
        .expect(200);
      const rows = (
        list.body as {
          data: { id: string; version: number; status: string; body: string }[];
        }
      ).data;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('DRAFT');
      expect(rows[0].body).toContain('requires review by your legal counsel');
      expect(rows[0].body.toLowerCase()).not.toMatch(
        /\bis compliant\b|\bfully compliant\b/,
      );
      draftId = rows[0].id;
      const mine = await http()
        .get('/privacy/me/notice')
        .set(auth(e1Token))
        .expect(200);
      expect((mine.body as { notice: unknown }).notice).toBeNull();
    });

    it('publishes the draft, then new versions are new rows; published rows are immutable', async () => {
      await http()
        .post(`/privacy/notices/${draftId}/publish`)
        .set(auth(e1Token))
        .send({})
        .expect(403);
      const pub = await http()
        .post(`/privacy/notices/${draftId}/publish`)
        .set(auth(adminToken))
        .send({})
        .expect(201);
      expect((pub.body as { status: string }).status).toBe('PUBLISHED');
      await http()
        .put(`/privacy/notices/${draftId}`)
        .set(auth(adminToken))
        .send({ body: 'edited' })
        .expect(409);
      await http()
        .post(`/privacy/notices/${draftId}/publish`)
        .set(auth(adminToken))
        .send({})
        .expect(409);

      const v2 = await http()
        .post('/privacy/notices')
        .set(auth(adminToken))
        .send({ title: 'Notice v2', body: 'Second version text' })
        .expect(201);
      expect((v2.body as { version: number; status: string }).version).toBe(2);
      expect((v2.body as { status: string }).status).toBe('PUBLISHED');

      const mine = await http()
        .get('/privacy/me/notice')
        .set(auth(e1Token))
        .expect(200);
      const body = mine.body as {
        notice: { version: number };
        acknowledged: boolean;
      };
      expect(body.notice.version).toBe(2);
      expect(body.acknowledged).toBe(false);
    });

    it('employee acknowledges the current notice', async () => {
      await http()
        .post('/privacy/me/notice/acknowledge')
        .set(auth(e1Token))
        .send({})
        .expect(201);
      const mine = await http()
        .get('/privacy/me/notice')
        .set(auth(e1Token))
        .expect(200);
      expect((mine.body as { acknowledged: boolean }).acknowledged).toBe(true);
      const other = await http()
        .get('/privacy/me/notice')
        .set(auth(e2Token))
        .expect(200);
      expect((other.body as { acknowledged: boolean }).acknowledged).toBe(
        false,
      );
    });
  });

  // ---- consent ----
  describe('consent', () => {
    it('grant then withdraw a consent-based purpose (append-only), with consequence text', async () => {
      const grant = await http()
        .post('/privacy/me/consents/optional_communications/grant')
        .set(auth(e1Token))
        .send({})
        .expect(201);
      expect((grant.body as { status: string }).status).toBe('GRANTED');
      const wd = await http()
        .post('/privacy/me/consents/optional_communications/withdraw')
        .set(auth(e1Token))
        .send({})
        .expect(201);
      const wdBody = wd.body as { status: string; consequence: string };
      expect(wdBody.status).toBe('WITHDRAWN');
      expect(wdBody.consequence).toMatch(/Operational emails/);
      const rows = await prisma.consentRecord.count({
        where: { userId: e1Id, purposeKey: 'optional_communications' },
      });
      expect(rows).toBe(2);
      const list = await http()
        .get('/privacy/me/consents')
        .set(auth(e1Token))
        .expect(200);
      const item = (
        list.body as { data: { purposeKey: string; status: string }[] }
      ).data.find((c) => c.purposeKey === 'optional_communications');
      expect(item?.status).toBe('WITHDRAWN');
    });

    it('refuses consent operations for purposes that rest on another legal basis', async () => {
      await http()
        .post('/privacy/me/consents/payroll/withdraw')
        .set(auth(e1Token))
        .send({})
        .expect(400);
      await http()
        .post('/privacy/me/consents/payroll/grant')
        .set(auth(e1Token))
        .send({})
        .expect(400);
      await http()
        .post('/privacy/me/consents/nope/grant')
        .set(auth(e1Token))
        .send({})
        .expect(404);
    });
  });

  // ---- request lifecycle ----
  describe('requests', () => {
    it('rejects an unknown correction field and employees cannot use the HR endpoints', async () => {
      await http()
        .post('/privacy/me/requests')
        .set(auth(e1Token))
        .send({ type: 'CORRECTION', fields: { role: 'ADMIN' } })
        .expect(400);
      await http().get('/privacy/requests').set(auth(e1Token)).expect(403);
    });

    it('whitelisted-only correction is auto-applied; SLA due date follows settings', async () => {
      const created = await http()
        .post('/privacy/me/requests')
        .set(auth(e1Token))
        .send({
          type: 'UPDATE',
          fields: { phone: '9111111111', currentAddress: 'New Address' },
        })
        .expect(201);
      const r = created.body as {
        id: string;
        requestNo: string;
        status: string;
        dueDate: string;
      };
      expect(r.requestNo).toMatch(/^PRV-\d{5}$/);
      expect(r.status).toBe('SUBMITTED');
      const days = (new Date(r.dueDate).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(9);
      expect(days).toBeLessThan(10.1);

      // another employee cannot see it; HR can assign and approve it
      await http()
        .get(`/privacy/me/requests/${r.id}`)
        .set(auth(e2Token))
        .expect(404);
      await http()
        .post(`/privacy/requests/${r.id}/assign`)
        .set(auth(hrToken))
        .send({ assignedToId: await hrId() })
        .expect(201);
      const approved = await http()
        .post(`/privacy/requests/${r.id}/review`)
        .set(auth(hrToken))
        .send({ decision: 'APPROVED' })
        .expect(201);
      expect((approved.body as { status: string }).status).toBe('APPROVED');
      const user = await prisma.user.findFirst({ where: { id: e1Id } });
      expect(user?.contactNumber).toBe('9111111111');
      expect(
        (user?.personalData as { currentAddress: string }).currentAddress,
      ).toBe('New Address');
      const done = await http()
        .post(`/privacy/requests/${r.id}/complete`)
        .set(auth(hrToken))
        .send({})
        .expect(201);
      expect(
        (done.body as { status: string; completedAt: string }).status,
      ).toBe('COMPLETED');
    });

    it('controlled fields are NOT auto-changed (ACTION_REQUIRED with resolution text)', async () => {
      const created = await http()
        .post('/privacy/me/requests')
        .set(auth(e1Token))
        .send({
          type: 'CORRECTION',
          fields: {
            panNumber: 'ZZZZZ9999Z',
            bankAccountNo: '999',
            phone: '9222222222',
          },
        })
        .expect(201);
      const id = (created.body as { id: string }).id;
      const res = await http()
        .post(`/privacy/requests/${id}/review`)
        .set(auth(adminToken))
        .send({ decision: 'APPROVED' })
        .expect(201);
      const body = res.body as {
        status: string;
        resolution: string;
        result: { controlledFields: string[]; appliedFields: string[] };
      };
      expect(body.status).toBe('ACTION_REQUIRED');
      expect(body.resolution).toMatch(/NOT changed automatically/);
      expect(body.result.controlledFields.sort()).toEqual([
        'bankAccountNo',
        'panNumber',
      ]);
      const user = await prisma.user.findFirst({ where: { id: e1Id } });
      // Sensitive keys are encrypted at rest; decrypt to compare.
      const pd = decryptPersonalData(user?.personalData) as {
        panNumber: string;
        bankAccountNo: string;
      };
      expect(pd.panNumber).toBe('ABCDE1234F');
      expect(pd.bankAccountNo).toBe('123456789012');
      expect(user?.contactNumber).toBe('9222222222');
      // HR must describe manual handling to close it
      await http()
        .post(`/privacy/requests/${id}/complete`)
        .set(auth(adminToken))
        .send({})
        .expect(400);
      await http()
        .post(`/privacy/requests/${id}/complete`)
        .set(auth(adminToken))
        .send({
          resolution:
            'Verified documents and updated through HR profile process.',
        })
        .expect(201);
    });

    it('an employee can cancel a SUBMITTED request only; reject needs a note', async () => {
      const created = await http()
        .post('/privacy/me/requests')
        .set(auth(e2Token))
        .send({ type: 'ACCESS' })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await http()
        .post('/privacy/me/requests')
        .set(auth(e2Token))
        .send({ type: 'ACCESS' })
        .expect(409);
      await http()
        .post(`/privacy/requests/${id}/review`)
        .set(auth(hrToken))
        .send({ decision: 'REJECTED' })
        .expect(400);
      const cancelled = await http()
        .post(`/privacy/me/requests/${id}/cancel`)
        .set(auth(e2Token))
        .expect(201);
      expect((cancelled.body as { status: string }).status).toBe('CANCELLED');
      await http()
        .post(`/privacy/me/requests/${id}/cancel`)
        .set(auth(e2Token))
        .expect(409);
    });

    async function hrId(): Promise<string> {
      const u = await prisma.user.findFirst({
        where: { email: 'privacy-e2e-hr@example.test' },
      });
      return u!.id;
    }
  });

  // ---- export ----
  describe('export', () => {
    it('approval generates a masked JSON of own data; download URL is signed, owner-only and audited', async () => {
      await prisma.employeeDocument.create({
        data: {
          organizationId: orgId,
          employeeId: e1Id,
          docType: 'PAN Card',
          fileName: 'pan.pdf',
          fileUrl: `${orgId}/documents/none.pdf`,
        },
      });
      const created = await http()
        .post('/privacy/me/requests')
        .set(auth(e1Token))
        .send({ type: 'EXPORT' })
        .expect(201);
      const id = (created.body as { id: string }).id;
      // not downloadable before approval
      await http()
        .get(`/privacy/me/requests/${id}/download`)
        .set(auth(e1Token))
        .expect(404);
      const approved = await http()
        .post(`/privacy/requests/${id}/review`)
        .set(auth(hrToken))
        .send({ decision: 'APPROVED' })
        .expect(201);
      expect(
        (approved.body as { exportReady: boolean; status: string }).exportReady,
      ).toBe(true);
      expect(JSON.stringify(approved.body)).not.toContain('privacy-exports');

      await http()
        .get(`/privacy/me/requests/${id}/download`)
        .set(auth(e2Token))
        .expect(404);
      const dl = await http()
        .get(`/privacy/me/requests/${id}/download`)
        .set(auth(e1Token))
        .expect(200);
      const { url, expiresInSeconds } = dl.body as {
        url: string;
        expiresInSeconds: number;
      };
      expect(url).toMatch(/^\/files\//);
      expect(expiresInSeconds).toBeLessThanOrEqual(3600);

      const key = (await prisma.dataRequest.findFirst({ where: { id } }))!
        .exportFileKey!;
      createdFiles.push(path.join(UPLOAD_ROOT, key));
      const file = await http().get(url).expect(200);
      const text = Buffer.isBuffer(file.body)
        ? file.body.toString('utf8')
        : file.text;
      expect(text).not.toContain('ABCDE1234F');
      expect(text).not.toContain('123456789012');
      expect(text).toContain('234F'); // masked last-4 only
      expect(text).not.toContain('privacy-e2e-e2@example.test');
      const parsed = JSON.parse(text) as {
        documents: { docType: string }[];
        profile: { email: string };
      };
      expect(parsed.profile.email).toBe('privacy-e2e-e1@example.test');
      expect(parsed.documents[0].docType).toBe('PAN Card');

      const audit = await http()
        .get('/privacy/audit-log')
        .query({ action: 'DATA_EXPORT_DOWNLOADED' })
        .set(auth(adminToken))
        .expect(200);
      expect((audit.body as { total: number }).total).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- erasure ----
  describe('erasure', () => {
    it('is restricted (Deletion Restricted + reasons) when payroll exists; nothing is changed', async () => {
      await prisma.payrollRun.create({
        data: { organizationId: orgId, employeeId: e2Id, month: 1, year: 2026 },
      });
      const created = await http()
        .post('/privacy/me/requests')
        .set(auth(e2Token))
        .send({ type: 'ERASURE' })
        .expect(201);
      const c = created.body as {
        id: string;
        deletionRestricted: boolean;
        restrictionReasons: string[];
      };
      expect(c.deletionRestricted).toBe(true);
      expect(c.restrictionReasons.join(' ')).toMatch(/Payroll/);

      const res = await http()
        .post(`/privacy/requests/${c.id}/review`)
        .set(auth(hrToken))
        .send({ decision: 'APPROVED' })
        .expect(201);
      const body = res.body as {
        status: string;
        resolution: string;
        deletionRestricted: boolean;
      };
      expect(body.status).toBe('ACTION_REQUIRED');
      expect(body.resolution).toMatch(/^Deletion Restricted:/);
      expect(body.deletionRestricted).toBe(true);
      expect(await prisma.user.count({ where: { id: e2Id } })).toBe(1);
      expect(
        await prisma.payrollRun.count({ where: { employeeId: e2Id } }),
      ).toBe(1);
    });

    it('otherwise anonymizes optional personalData and removes non-required documents only', async () => {
      await prisma.documentRequirement.create({
        data: {
          organizationId: orgId,
          name: 'Required Proof',
          isMandatory: true,
        },
      });
      const dir = path.join(UPLOAD_ROOT, orgId, 'documents');
      fs.mkdirSync(dir, { recursive: true });
      const extra = path.join(dir, 'privacy-e2e-extra.pdf');
      const req = path.join(dir, 'privacy-e2e-required.pdf');
      fs.writeFileSync(extra, 'x');
      fs.writeFileSync(req, 'x');
      createdFiles.push(extra, req);
      await prisma.employeeDocument.createMany({
        data: [
          {
            organizationId: orgId,
            employeeId: e3Id,
            docType: 'Hobby Certificate',
            fileName: 'h.pdf',
            fileUrl: `${orgId}/documents/privacy-e2e-extra.pdf`,
          },
          {
            organizationId: orgId,
            employeeId: e3Id,
            docType: 'Required Proof',
            fileName: 'r.pdf',
            fileUrl: `${orgId}/documents/privacy-e2e-required.pdf`,
          },
        ],
      });
      await prisma.user.update({
        where: { id: e3Id },
        data: {
          personalData: {
            fatherName: 'Dummy',
            bloodGroup: 'O+',
            panNumber: 'PQRST1234U',
            bankAccountNo: '55555',
          },
        },
      });
      // The suggested default employee_profile retention (96 months) would rightly restrict erasure of an
      // active employee; clear it so this case exercises the unrestricted anonymization path.
      const cur = (await http().get('/privacy/settings').set(auth(adminToken)))
        .body as { retentionRules: { dataType: string }[] };
      await http()
        .put('/privacy/settings')
        .set(auth(adminToken))
        .send({
          retentionRules: cur.retentionRules.map((r) =>
            r.dataType === 'employee_profile'
              ? { ...r, periodMonths: null }
              : r,
          ),
        })
        .expect(200);
      const created = await http()
        .post('/privacy/me/requests')
        .set(auth(e3Token))
        .send({ type: 'ERASURE' })
        .expect(201);
      const id = (created.body as { id: string; deletionRestricted: boolean })
        .id;
      expect(
        (created.body as { deletionRestricted: boolean }).deletionRestricted,
      ).toBe(false);
      const res = await http()
        .post(`/privacy/requests/${id}/review`)
        .set(auth(hrToken))
        .send({ decision: 'APPROVED' })
        .expect(201);
      expect((res.body as { status: string }).status).toBe('APPROVED');

      const user = await prisma.user.findFirst({ where: { id: e3Id } });
      expect(user).not.toBeNull();
      const pd = decryptPersonalData(user!.personalData) as Record<
        string,
        unknown
      >;
      expect(pd.fatherName).toBeUndefined();
      expect(pd.bloodGroup).toBeUndefined();
      expect(pd.panNumber).toBe('PQRST1234U'); // statutory/required data untouched
      expect(pd.bankAccountNo).toBe('55555');
      const docs = await prisma.employeeDocument.findMany({
        where: { employeeId: e3Id },
      });
      expect(docs.map((d) => d.docType)).toEqual(['Required Proof']);
      await new Promise((r) => setTimeout(r, 100));
      expect(fs.existsSync(extra)).toBe(false);
      expect(fs.existsSync(req)).toBe(true);
    });
  });

  // ---- data summary ----
  it('my-data summary shows masked identifiers only', async () => {
    const res = await http()
      .get('/privacy/me/data-summary')
      .set(auth(e1Token))
      .expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('ABCDE1234F');
    expect(text).not.toContain('123456789012');
    const body = res.body as {
      identifiers: { pan: string };
      categoriesHeld: unknown[];
      documents: unknown[];
    };
    expect(body.identifiers.pan).toBe('******234F');
    expect(body.categoriesHeld.length).toBeGreaterThan(0);
    expect(body.documents.length).toBeGreaterThan(0);
  });

  // ---- breaches / sharing RBAC ----
  describe('breach register', () => {
    it('is ADMIN-only; incident numbers are sequential; closing sets closedAt', async () => {
      const payload = {
        detectedAt: new Date().toISOString(),
        affectedSystem: 'Dummy system',
        severity: 'HIGH',
      };
      await http()
        .post('/privacy/breaches')
        .set(auth(e1Token))
        .send(payload)
        .expect(403);
      await http()
        .post('/privacy/breaches')
        .set(auth(hrToken))
        .send(payload)
        .expect(403);
      await http().get('/privacy/breaches').set(auth(hrToken)).expect(403);
      const a = await http()
        .post('/privacy/breaches')
        .set(auth(adminToken))
        .send(payload)
        .expect(201);
      const b = await http()
        .post('/privacy/breaches')
        .set(auth(adminToken))
        .send(payload)
        .expect(201);
      expect((a.body as { incidentNo: string }).incidentNo).toBe('INC-00001');
      expect((b.body as { incidentNo: string }).incidentNo).toBe('INC-00002');
      const id = (a.body as { id: string }).id;
      const closed = await http()
        .post(`/privacy/breaches/${id}/close`)
        .set(auth(adminToken))
        .send({ resolution: 'Resolved (dummy)' })
        .expect(201);
      const cb = closed.body as { status: string; closedAt: string };
      expect(cb.status).toBe('CLOSED');
      expect(cb.closedAt).toBeTruthy();
      await http()
        .put(`/privacy/breaches/${id}`)
        .set(auth(adminToken))
        .send({ description: 'x' })
        .expect(409);
    });

    it('sharing records CRUD is ADMIN-only', async () => {
      await http()
        .post('/privacy/sharing')
        .set(auth(hrToken))
        .send({ recipient: 'X', dataCategory: 'Y' })
        .expect(403);
      const created = await http()
        .post('/privacy/sharing')
        .set(auth(adminToken))
        .send({
          recipient: 'Dummy Auditor',
          dataCategory: 'Payroll summary',
          purpose: 'Audit',
        })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await http()
        .put(`/privacy/sharing/${id}`)
        .set(auth(adminToken))
        .send({ status: 'INACTIVE' })
        .expect(200);
      await http()
        .delete(`/privacy/sharing/${id}`)
        .set(auth(adminToken))
        .expect(200);
    });
  });

  // ---- retention review ----
  it('retention review is report-only and reflects configured periods', async () => {
    const first = await http()
      .get('/privacy/retention-review')
      .set(auth(adminToken))
      .expect(200);
    const rules = first.body as {
      reportOnly: boolean;
      rules: { status: string }[];
    };
    expect(rules.reportOnly).toBe(true);
    // Suggested defaults are pre-filled, so nothing is NOT_CONFIGURED out of the box.
    expect(rules.rules.some((r) => r.status !== 'NOT_CONFIGURED')).toBe(true);
    await http()
      .get('/privacy/retention-review')
      .set(auth(hrToken))
      .expect(403);

    const settings = (
      await http().get('/privacy/settings').set(auth(adminToken))
    ).body as {
      retentionRules: { dataType: string; periodMonths: number | null }[];
    };
    const updated = settings.retentionRules.map((r) =>
      r.dataType === 'notifications'
        ? {
            ...r,
            periodMonths: 1,
            basis: 'Dummy basis',
            action: 'MANUAL_REVIEW',
          }
        : r,
    );
    await http()
      .put('/privacy/settings')
      .set(auth(adminToken))
      .send({ retentionRules: updated })
      .expect(200);
    const second = await http()
      .get('/privacy/retention-review')
      .set(auth(adminToken))
      .expect(200);
    const n = (
      second.body as {
        rules: { dataType: string; status: string; candidateCount: number }[];
      }
    ).rules.find((r) => r.dataType === 'notifications');
    expect(n?.status).toBe('EVALUATED');
    expect(typeof n?.candidateCount).toBe('number');
  });

  // ---- audit trail ----
  describe('audit hash chain', () => {
    it('has no update/delete routes and never stores sensitive values', async () => {
      await http()
        .delete('/privacy/audit-log')
        .set(auth(adminToken))
        .expect(404);
      await http()
        .put('/privacy/audit-log')
        .set(auth(adminToken))
        .send({})
        .expect(404);
      await http().get('/privacy/audit-log').set(auth(hrToken)).expect(403);
      const rows = await prisma.privacyAuditLog.findMany({
        where: { organizationId: orgId },
      });
      expect(rows.length).toBeGreaterThan(10);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain('ABCDE1234F');
      expect(dump).not.toContain('New Address');
      expect(dump).not.toContain('9111111111');
    });

    it('filters by category and verifies intact, then detects tampering', async () => {
      const list = await http()
        .get('/privacy/audit-log')
        .query({ category: 'CONSENT' })
        .set(auth(adminToken))
        .expect(200);
      const data = (list.body as { data: { category: string }[] }).data;
      expect(data.length).toBe(2);
      expect(data.every((d) => d.category === 'CONSENT')).toBe(true);

      const ok = await http()
        .get('/privacy/audit-log/verify')
        .set(auth(adminToken))
        .expect(200);
      expect((ok.body as { intact: boolean }).intact).toBe(true);
      await http()
        .get('/privacy/audit-log/verify')
        .set(auth(e1Token))
        .expect(403);

      const target = await prisma.privacyAuditLog.findFirst({
        where: { organizationId: orgId },
        orderBy: { seq: 'asc' },
        skip: 3,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "privacy_audit_logs" SET "action" = 'TAMPERED' WHERE "id" = '${target!.id}'`,
      );
      const bad = await http()
        .get('/privacy/audit-log/verify')
        .set(auth(adminToken))
        .expect(200);
      const b = bad.body as {
        intact: boolean;
        brokenAtIndex: number;
        brokenRowId: string;
      };
      expect(b.intact).toBe(false);
      expect(b.brokenAtIndex).toBe(3);
      expect(b.brokenRowId).toBe(target!.id);
    });
  });

  it('auto-recorded sharing is upserted: two exports yield one row', async () => {
    const svc = app.get(PrivacyService);
    const input = {
      recipient: 'EPFO (dedupe test)',
      dataCategory: 'STATUTORY',
      purpose: 'PF statutory export file',
      integration: 'export',
    };
    await svc.recordSystemSharing(orgId, input);
    await svc.recordSystemSharing(orgId, input);
    const rows = await prisma.dataSharingRecord.findMany({
      where: { organizationId: orgId, recipient: input.recipient },
    });
    expect(rows).toHaveLength(1);
  });
});
