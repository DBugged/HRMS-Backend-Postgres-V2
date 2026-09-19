import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EmailService } from '../src/notifications/email.service';

// Dummy data only. Covers: no-department manager scope, manager masking of sensitive personalData,
// document-view audit rows, and that email failure logs never contain the body.

interface AuthBody {
  accessToken: string;
}
const PASSWORD = 'TestPass123!';

describe('Privacy security hardening (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let orgId: string;
  let adminToken: string;
  let noDeptMgr: { id: string; token: string };
  let deptMgr: { id: string; token: string };
  let e1Id: string;
  let e1Token: string;

  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function makeUser(
    email: string,
    name: string,
    role?: 'MANAGER' | 'EMPLOYEE',
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
      organizationName: 'Privacy Sec E2E Org',
      name: 'Founder',
      email: 'privsec-admin@example.test',
      password: PASSWORD,
    });
    const login = await http()
      .post('/auth/login')
      .send({ email: 'privsec-admin@example.test', password: PASSWORD });
    adminToken = (login.body as AuthBody).accessToken;

    noDeptMgr = await makeUser(
      'privsec-m0@example.test',
      'No Dept Mgr',
      'MANAGER',
    );
    deptMgr = await makeUser('privsec-m1@example.test', 'Dept Mgr', 'MANAGER');
    const e1 = await makeUser('privsec-e1@example.test', 'Employee One');
    e1Id = e1.id;
    e1Token = e1.token;
    orgId = (await prisma.user.findFirstOrThrow({ where: { id: e1Id } }))
      .organizationId;

    const dept = await prisma.department.create({
      data: { name: 'PrivSec Dept', code: 'PSD', organizationId: orgId },
    });
    await prisma.user.updateMany({
      where: { id: { in: [deptMgr.id, e1Id] } },
      data: { departmentId: dept.id },
    });
    await prisma.user.update({
      where: { id: e1Id },
      data: {
        personalData: {
          panNumber: 'ABCDE1234F',
          bankAccountNo: '123456789012',
          bankIFSC: 'HDFC0001234',
          currentAddress: 'Some Street',
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "privacy_audit_logs", "privacy_settings", "privacy_notice_versions", "consent_records", "data_requests", "data_processors", "data_sharing_records", "breach_incidents", "employee_documents", "document_requirements", "payroll_runs", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('a MANAGER with no department sees only their own record, not every employee', async () => {
    const res = await http()
      .get('/employees')
      .set(auth(noDeptMgr.token))
      .expect(200);
    const body = res.body as { data: { id: string }[]; total: number };
    expect(body.data.map((r) => r.id)).toEqual([noDeptMgr.id]);
    expect(body.total).toBe(1);
    await http()
      .get(`/employees/${e1Id}`)
      .set(auth(noDeptMgr.token))
      .expect(403);
  });

  it('MANAGER sees sensitive personalData masked; ADMIN sees it in full', async () => {
    const asMgr = await http()
      .get(`/employees/${e1Id}`)
      .set(auth(deptMgr.token))
      .expect(200);
    const pdM = (asMgr.body as { personalData: Record<string, string> })
      .personalData;
    expect(pdM.panNumber).toBe('******234F');
    expect(pdM.bankAccountNo).toBe('********9012');
    expect(pdM.bankIFSC).toBe('*******1234');
    expect(pdM.currentAddress).toBe('Some Street');

    const list = await http()
      .get('/employees')
      .set(auth(deptMgr.token))
      .expect(200);
    const row = (
      list.body as {
        data: { id: string; personalData: Record<string, string> }[];
      }
    ).data.find((r) => r.id === e1Id)!;
    expect(row.personalData.panNumber).toBe('******234F');

    const asAdmin = await http()
      .get(`/employees/${e1Id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(
      (asAdmin.body as { personalData: Record<string, string> }).personalData
        .panNumber,
    ).toBe('ABCDE1234F');
  });

  it('viewing another employee and listing documents each write a privacy audit row (ids only)', async () => {
    await prisma.employeeDocument.create({
      data: {
        organizationId: orgId,
        employeeId: e1Id,
        docType: 'PAN Card',
        fileName: 'pan.pdf',
        fileUrl: `${orgId}/documents/privsec.pdf`,
      },
    });
    await http()
      .get(`/employees/${e1Id}/documents`)
      .set(auth(e1Token))
      .expect(200);
    await http().get(`/employees/${e1Id}`).set(auth(adminToken)).expect(200);

    const find = async (action: string) => {
      for (let i = 0; i < 20; i++) {
        const rows = await prisma.privacyAuditLog.findMany({
          where: { organizationId: orgId, action },
        });
        if (rows.length) return rows;
        await new Promise((r) => setTimeout(r, 100));
      }
      return [];
    };
    const docRows = await find('DOCUMENT_VIEWED');
    expect(docRows.length).toBeGreaterThan(0);
    expect(docRows[0].targetUserId).toBe(e1Id);
    expect(JSON.stringify(docRows[0].meta)).not.toContain('privsec.pdf');
    const pdRows = await find('PERSONAL_DATA_VIEWED');
    expect(pdRows.length).toBeGreaterThan(0);
  });

  it('rejects a document fileUrl pointing at another organization or using traversal', async () => {
    await http()
      .post(`/employees/${e1Id}/documents`)
      .set(auth(adminToken))
      .send({
        docType: 'X',
        fileName: 'x.pdf',
        fileUrl: '00000000-0000-0000-0000-000000000000/documents/x.pdf',
      })
      .expect(400);
    await http()
      .post(`/employees/${e1Id}/documents`)
      .set(auth(adminToken))
      .send({
        docType: 'X',
        fileName: 'x.pdf',
        fileUrl: `${orgId}/../other/documents/x.pdf`,
      })
      .expect(400);
  });

  describe('email failure logging', () => {
    const SECRET = 'S3cretInitialPw!';
    const html = `<p>Password: <strong>${SECRET}</strong></p>`;
    let spies: jest.SpyInstance[];
    const logged = () =>
      spies
        .flatMap((s) => (s.mock.calls as unknown[][]).map((c) => String(c[0])))
        .join('\n');

    beforeEach(() => {
      spies = [
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
        jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined),
      ];
    });
    afterEach(() => {
      jest.restoreAllMocks();
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
    });

    it('SMTP unconfigured: logs recipient + subject, never the body', async () => {
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
      delete process.env.EMAIL_DRIVER;
      await app
        .get(EmailService)
        .send({ to: 'x@example.test', subject: 'Welcome', html });
      const out = logged();
      expect(out).toContain('x@example.test');
      expect(out).toContain('Welcome');
      expect(out).not.toContain(SECRET);
    });

    it('SMTP send failure: logs recipient + subject + error, never the body', async () => {
      process.env.SMTP_USER = 'u';
      process.env.SMTP_PASS = 'p';
      delete process.env.EMAIL_DRIVER;
      const svc = app.get<EmailService>(EmailService) as unknown as {
        transporter: unknown;
      };
      svc.transporter = {
        sendMail: () => Promise.reject(new Error('smtp down')),
      };
      await app
        .get(EmailService)
        .send({ to: 'y@example.test', subject: 'Welcome', html });
      svc.transporter = null;
      const out = logged();
      expect(out).toContain('y@example.test');
      expect(out).toContain('smtp down');
      expect(out).not.toContain(SECRET);
    });
  });
});
