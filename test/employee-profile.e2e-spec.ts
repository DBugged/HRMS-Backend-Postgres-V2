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
interface EmployeeBody {
  employee: { id: string };
  generatedPassword: string;
}
interface PersonalDataBody {
  personalData: Record<string, unknown>;
}
interface FullProfileBody {
  id: string;
  documents: { id: string }[];
  assets: { id: string }[];
}
interface RoleHistoryEntry {
  previousRole: string | null;
  newRole: string | null;
  previousDesignation: string | null;
  newDesignation: string | null;
}
interface StatusHistoryEntry {
  previousStatus: string | null;
  newStatus: string;
}
interface DocumentBody {
  id: string;
  status: string;
  reviewReason: string;
  fileUrl: string;
}
interface AssetBody {
  id: string;
  status: string;
  returnedDate: string | null;
  returnedById: string | null;
  assetTag: string | null;
  isActive: boolean;
}

const PASSWORD = 'TestPass123!';

describe('Employee Rich Profile (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let empId: string;
  let empToken: string;
  let otherEmpId: string;

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
      organizationName: 'Employee Profile E2E Org',
      name: 'Founder',
      email: 'profile-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'profile-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'profile-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'profile-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        name: 'Profile Employee',
        email: 'profile-e2e-emp@example.test',
      });
    const empBody = empCreate.body as EmployeeBody;
    empId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'profile-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    empToken = (empLogin.body as AuthBody).accessToken;

    const otherCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        name: 'Other Employee',
        email: 'profile-e2e-other@example.test',
      });
    const otherBody = otherCreate.body as EmployeeBody;
    otherEmpId = otherBody.employee.id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "employee_documents", "employee_assets", "employee_role_history", "employment_status_history", "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  describe('personal-data', () => {
    it('EMPLOYEE can update their own personal data (partial merge)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${empId}/personal-data`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ personalData: { fullNameAsPerGovtId: 'Emp Full Name' } })
        .expect(200);
      expect(
        (res.body as PersonalDataBody).personalData.fullNameAsPerGovtId,
      ).toBe('Emp Full Name');
      expect((res.body as PersonalDataBody).personalData.profileCompleted).toBe(
        false,
      );
    });

    it('HR/Admin can fill in and correct bank details, government IDs and the address, and so can the employee', async () => {
      const send = (token: string, personalData: object) =>
        request(app.getHttpServer())
          .patch(`/employees/${empId}/personal-data`)
          .set('Authorization', `Bearer ${token}`)
          .send({ personalData });
      await send(empToken, {
        bankName: 'Test Bank',
        panNumber: 'ABCDE1234F',
        currentAddress: '12 Main Street, Mumbai, Maharashtra 400001',
      }).expect(200);
      // HR/Admin may set and correct bank details and identifiers on an employee's record (audited, see 67be87f).
      const bank = await send(hrToken, { bankName: 'Other Bank' }).expect(200);
      expect((bank.body as PersonalDataBody).personalData.bankName).toBe(
        'Other Bank',
      );
      const pan = await send(adminToken, { panNumber: 'ZZZZZ9999Z' }).expect(
        200,
      );
      // Responses mask it; saving the masked value back keeps the real number.
      expect((pan.body as PersonalDataBody).personalData.panNumber).toBe(
        '******999Z',
      );
      await send(adminToken, { panNumber: '******999Z' }).expect(200);
      const full = await request(app.getHttpServer())
        .get(`/employees/${empId}/personal-data/sensitive`)
        .set('Authorization', `Bearer ${empToken}`)
        .expect(200);
      expect((full.body as { panNumber: string }).panNumber).toBe('ZZZZZ9999Z');
      const fixed = await send(hrToken, {
        currentAddress: '99 Elsewhere Road, Pune, Maharashtra 411001',
      }).expect(200);
      expect((fixed.body as PersonalDataBody).personalData.currentAddress).toBe(
        '99 Elsewhere Road, Pune, Maharashtra 411001',
      );
      await send(adminToken, {
        currentAddress: '12 Main Street, Mumbai, Maharashtra 400001',
      }).expect(200);
      // Resending the stored values (an edit form resends its whole section) is fine, and so are other fields.
      await send(hrToken, {
        bankName: 'Test Bank',
        maritalStatus: 'Single',
      }).expect(200);
      const res = await send(empToken, {
        bankName: 'Employee Changed Bank',
      }).expect(200);
      expect((res.body as PersonalDataBody).personalData.bankName).toBe(
        'Employee Changed Bank',
      );
    });

    it('PAN is required: once given it can be corrected but not removed', async () => {
      const send = (personalData: object) =>
        request(app.getHttpServer())
          .patch(`/employees/${empId}/personal-data`)
          .set('Authorization', `Bearer ${empToken}`)
          .send({ personalData });
      await send({ panNumber: 'ABCDE1234F' }).expect(200);
      const res = await send({ panNumber: '' }).expect(400);
      expect((res.body as { message: string }).message).toMatch(
        /PAN is required/,
      );
      await send({ panNumber: 'PQRST6789K' }).expect(200);
    });

    it('EMPLOYEE cannot change their own personalEmail (silently dropped, no error)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${empId}/personal-data`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ personalData: { personalEmail: 'hijacked@example.test' } })
        .expect(200);
      expect(
        (res.body as PersonalDataBody).personalData.personalEmail,
      ).not.toBe('hijacked@example.test');
    });

    it('HR can change personalEmail', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${empId}/personal-data`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ personalData: { personalEmail: 'corrected@example.test' } })
        .expect(200);
      expect((res.body as PersonalDataBody).personalData.personalEmail).toBe(
        'corrected@example.test',
      );
    });

    it('EMPLOYEE cannot update another employee personal data (403)', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${otherEmpId}/personal-data`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ personalData: { fullNameAsPerGovtId: 'Hijacked' } })
        .expect(403);
    });

    it('HR can update any employee personal data', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/personal-data`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ personalData: { dateOfBirth: '1995-05-05' } })
        .expect(200);
    });

    it('rejects a calendar-impossible date of birth instead of persisting it as-is', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/personal-data`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ personalData: { dateOfBirth: '2026-02-30' } })
        .expect(400);
    });

    it('rejects a future date of birth', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/personal-data`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ personalData: { dateOfBirth: '2099-01-01' } })
        .expect(400);
    });

    it('rejects an impossible previousEmployment date', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/personal-data`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({
          personalData: {
            previousEmployment: [
              { startDate: '2020-13-01', endDate: '2021-01-01' },
            ],
          },
        })
        .expect(400);
    });

    it('profileCompleted flips true once all 9 required fields are present, and stays stamped', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${empId}/personal-data`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({
          personalData: {
            // Every field in REQUIRED_FOR_COMPLETION (personal-data.ts): a profile is only Complete when all of them
            // are filled.
            fullNameAsPerGovtId: 'Emp Full Name',
            dateOfBirth: '1995-05-05',
            gender: 'Female',
            maritalStatus: 'Single',
            bloodGroup: 'O+',
            currentAddress: '123 Main St, Mumbai, Maharashtra 400001',
            fatherName: 'John Doe',
            fatherContact: '9876543210',
            motherName: 'Jane Doe',
            motherContact: '9876543211',
            emergencyContact1Name: 'Sam Doe',
            emergencyContact1Number: '9876543212',
            emergencyContact2Name: 'Sue Doe',
            emergencyContact2Number: '9876543213',
            totalExperience: '3 years',
            currentOrganization: 'Acme',
            relevantExperience: 'Backend work',
            bankAccountHolderName: 'Emp Full Name',
            bankName: 'HDFC Bank',
            bankAccountNo: '123456789',
            bankIFSC: 'HDFC0001234',
          },
        })
        .expect(200);
      const personalData = (res.body as PersonalDataBody).personalData;
      expect(personalData.profileCompleted).toBe(true);
      expect(personalData.profileCompletedAt).not.toBeNull();
    });

    it('changing bankAccountNo/bankIFSC writes a BANK_DETAILS_UPDATED audit log entry, but a no-op re-send does not', async () => {
      // The prior test in this describe block already set bankAccountNo/
      // bankIFSC once (from empty), so this counts the delta rather than
      // asserting an absolute total.
      const before = await prisma.auditLog.count({
        where: { action: 'BANK_DETAILS_UPDATED', targetId: empId },
      });

      await request(app.getHttpServer())
        .patch(`/employees/${empId}/personal-data`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({
          personalData: {
            bankAccountNo: '111122223333',
            bankIFSC: 'ICIC0000111',
          },
        })
        .expect(200);
      const afterChange = await prisma.auditLog.count({
        where: { action: 'BANK_DETAILS_UPDATED', targetId: empId },
      });
      expect(afterChange).toBe(before + 1);

      // Re-sending the exact same values is a no-op — must not log again.
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/personal-data`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({
          personalData: {
            bankAccountNo: '111122223333',
            bankIFSC: 'ICIC0000111',
          },
        })
        .expect(200);
      const afterNoOp = await prisma.auditLog.count({
        where: { action: 'BANK_DETAILS_UPDATED', targetId: empId },
      });
      expect(afterNoOp).toBe(before + 1);
    });
  });

  describe('cancelled cheque replacement', () => {
    it("an Admin can replace an employee's cancelled cheque at any time, and it is logged", async () => {
      const send = (key: string) =>
        request(app.getHttpServer())
          .patch(`/employees/${empId}/personal-data`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ personalData: { cancelledChequeUrl: key } });
      const before = await prisma.auditLog.count({
        where: { action: 'CANCELLED_CHEQUE_REPLACED', targetId: empId },
      });
      await send('cheque-e2e-one.pdf').expect(200);
      await send('cheque-e2e-two.pdf').expect(200);
      const after = await prisma.auditLog.count({
        where: { action: 'CANCELLED_CHEQUE_REPLACED', targetId: empId },
      });
      expect(after).toBe(before + 2);
      // Re-sending the same key is a no-op: not logged again.
      await send('cheque-e2e-two.pdf').expect(200);
      expect(
        await prisma.auditLog.count({
          where: { action: 'CANCELLED_CHEQUE_REPLACED', targetId: empId },
        }),
      ).toBe(after);
    });
  });

  describe('full-profile / role-history / employment-status-history (HR/Admin only)', () => {
    it('HR can view an employee full profile including documents/assets arrays', async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${empId}/full-profile`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const body = res.body as FullProfileBody;
      expect(body.id).toBe(empId);
      expect(Array.isArray(body.documents)).toBe(true);
      expect(Array.isArray(body.assets)).toBe(true);
    });

    it('asks for a UAN only while PF is on for the company (the employee is permanent)', async () => {
      const flags = async () => {
        const full = await request(app.getHttpServer())
          .get(`/employees/${empId}/full-profile`)
          .set('Authorization', `Bearer ${hrToken}`)
          .expect(200);
        const me = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${empToken}`)
          .expect(200);
        return [
          (full.body as { uanRequired: boolean }).uanRequired,
          (me.body as { uanRequired: boolean }).uanRequired,
        ];
      };
      const emp = await prisma.user.findUniqueOrThrow({ where: { id: empId } });
      // A new organisation has no payroll settings row until first used.
      await prisma.payrollSettings.upsert({
        where: { organizationId: emp.organizationId },
        create: { organizationId: emp.organizationId },
        update: {},
      });
      await prisma.payrollSettings.updateMany({
        where: { organizationId: emp.organizationId },
        data: { pfEnabled: false },
      });
      expect(await flags()).toEqual([false, false]);
      await prisma.payrollSettings.updateMany({
        where: { organizationId: emp.organizationId },
        data: { pfEnabled: true },
      });
      expect(await flags()).toEqual([true, true]);
      await prisma.payrollSettings.updateMany({
        where: { organizationId: emp.organizationId },
        data: { pfEnabled: false },
      });
    });

    it('EMPLOYEE is forbidden from full-profile, role-history, and employment-status-history', async () => {
      await request(app.getHttpServer())
        .get(`/employees/${empId}/full-profile`)
        .set('Authorization', `Bearer ${empToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/employees/${empId}/role-history`)
        .set('Authorization', `Bearer ${empToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/employees/${empId}/employment-status-history`)
        .set('Authorization', `Bearer ${empToken}`)
        .expect(403);
    });

    it('changing role/designation via PATCH /employees/:id auto-logs an EmployeeRoleHistory entry', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${empId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'MANAGER' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/employees/${empId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ designation: 'Team Lead' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/employees/${empId}/role-history`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const entries = res.body as RoleHistoryEntry[];
      expect(entries.length).toBe(2);
      expect(
        entries.some(
          (e) => e.previousRole === 'EMPLOYEE' && e.newRole === 'MANAGER',
        ),
      ).toBe(true);
      expect(
        entries.some(
          (e) =>
            e.newDesignation === 'Team Lead' && e.previousDesignation === '',
        ),
      ).toBe(true);
    });

    it('an update that changes nothing tracked writes no new history row', async () => {
      const before = await request(app.getHttpServer())
        .get(`/employees/${empId}/role-history`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/employees/${empId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Renamed Only' })
        .expect(200);
      const after = await request(app.getHttpServer())
        .get(`/employees/${empId}/role-history`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect((after.body as RoleHistoryEntry[]).length).toBe(
        (before.body as RoleHistoryEntry[]).length,
      );
    });
  });

  describe('probation-decision', () => {
    it('rejects "extended" without newProbationEndDate', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${otherEmpId}/probation-decision`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'extended' })
        .expect(400);
    });

    it('extends probation, writes EmploymentStatusHistory, and updates the employee row', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${otherEmpId}/probation-decision`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          decision: 'extended',
          newProbationEndDate: '2026-12-31',
          note: 'Needs more time',
        })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/employees/${otherEmpId}/employment-status-history`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const entries = res.body as StatusHistoryEntry[];
      expect(entries.some((e) => e.newStatus === 'EXTENDED_PROBATION')).toBe(
        true,
      );
    });

    it('an extension must move the end date forward', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${otherEmpId}/probation-decision`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'extended', newProbationEndDate: '2026-11-30' })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/after the current one/);
    });

    it('confirms employment on a second decision', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${otherEmpId}/probation-decision`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'confirmed' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/employees/${otherEmpId}/employment-status-history`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const entries = res.body as StatusHistoryEntry[];
      expect(entries.some((e) => e.newStatus === 'CONFIRMED')).toBe(true);
    });

    it('EMPLOYEE cannot make a probation decision', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${otherEmpId}/probation-decision`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ decision: 'confirmed' })
        .expect(403);
    });
  });

  describe('documents', () => {
    let docId: string;

    it('EMPLOYEE can add their own document', async () => {
      const res = await request(app.getHttpServer())
        .post(`/employees/${empId}/documents`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({
          docType: 'PAN Card',
          fileName: 'pan.pdf',
          fileUrl: 'documents/pan.pdf',
        })
        .expect(201);
      const body = res.body as DocumentBody;
      docId = body.id;
      expect(body.status).toBe('PENDING');
      expect(body.fileUrl).toMatch(/^\/files\//);
    });

    it('EMPLOYEE cannot add a document for someone else', async () => {
      await request(app.getHttpServer())
        .post(`/employees/${otherEmpId}/documents`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({
          docType: 'PAN Card',
          fileName: 'pan.pdf',
          fileUrl: 'documents/pan.pdf',
        })
        .expect(403);
    });

    it('EMPLOYEE can list their own documents', async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${empId}/documents`)
        .set('Authorization', `Bearer ${empToken}`)
        .expect(200);
      const docs = res.body as DocumentBody[];
      expect(docs.length).toBe(1);
      expect(docs[0].fileUrl).toMatch(/^\/files\//);
    });

    it("EMPLOYEE cannot list another employee's documents", async () => {
      await request(app.getHttpServer())
        .get(`/employees/${otherEmpId}/documents`)
        .set('Authorization', `Bearer ${empToken}`)
        .expect(403);
    });

    it('EMPLOYEE cannot review a document (HR/Admin-only)', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/documents/${docId}/review`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ status: 'APPROVED' })
        .expect(403);
    });

    it('rejecting a document needs a reason, and the message says so', async () => {
      for (const body of [
        { status: 'REJECTED' },
        { status: 'REJECTED', reason: '   ' },
      ]) {
        const res = await request(app.getHttpServer())
          .patch(`/employees/${empId}/documents/${docId}/review`)
          .set('Authorization', `Bearer ${hrToken}`)
          .send(body)
          .expect(400);
        expect(JSON.stringify(res.body)).toMatch(/reason is required/i);
      }
    });

    it('HR can approve a document with a reason', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${empId}/documents/${docId}/review`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'REJECTED', reason: 'Blurry scan' })
        .expect(200);
      const body = res.body as DocumentBody;
      expect(body.status).toBe('REJECTED');
      expect(body.reviewReason).toBe('Blurry scan');
    });

    it('EMPLOYEE can remove their own document', async () => {
      await request(app.getHttpServer())
        .delete(`/employees/${empId}/documents/${docId}`)
        .set('Authorization', `Bearer ${empToken}`)
        .expect(200);
      const res = await request(app.getHttpServer())
        .get(`/employees/${empId}/documents`)
        .set('Authorization', `Bearer ${empToken}`)
        .expect(200);
      expect((res.body as DocumentBody[]).length).toBe(0);
    });

    it('EMPLOYEE cannot remove their own document once HR has approved it, but HR still can', async () => {
      const uploadRes = await request(app.getHttpServer())
        .post(`/employees/${empId}/documents`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({
          docType: 'Aadhar Card',
          fileName: 'aadhar.pdf',
          fileUrl: 'documents/aadhar.pdf',
        })
        .expect(201);
      const approvedDocId = (uploadRes.body as DocumentBody).id;

      await request(app.getHttpServer())
        .patch(`/employees/${empId}/documents/${approvedDocId}/review`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'APPROVED' })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/employees/${empId}/documents/${approvedDocId}`)
        .set('Authorization', `Bearer ${empToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .delete(`/employees/${empId}/documents/${approvedDocId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
    });

    it('an uploaded letter HR switches off is hidden from the employee but stays visible to HR', async () => {
      const uploadRes = await request(app.getHttpServer())
        .post(`/employees/${empId}/documents`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          docType: 'Signed Offer Letter',
          fileName: 'offer-signed.pdf',
          fileUrl: 'documents/offer-signed.pdf',
          category: 'LETTER',
        })
        .expect(201);
      const letterId = (uploadRes.body as DocumentBody).id;
      const listLetters = (token: string) =>
        request(app.getHttpServer())
          .get(`/employees/${empId}/documents?category=LETTER`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

      // Visible by default.
      expect((await listLetters(empToken)).body as DocumentBody[]).toHaveLength(
        1,
      );

      await request(app.getHttpServer())
        .patch(`/employees/${empId}/documents/${letterId}/visibility`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ visibleToEmployee: false })
        .expect(200);
      expect((await listLetters(empToken)).body as DocumentBody[]).toHaveLength(
        0,
      );
      expect((await listLetters(hrToken)).body as DocumentBody[]).toHaveLength(
        1,
      );

      // The employee cannot flip it back, and switching it on again shows it.
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/documents/${letterId}/visibility`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ visibleToEmployee: true })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/documents/${letterId}/visibility`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ visibleToEmployee: true })
        .expect(200);
      expect((await listLetters(empToken)).body as DocumentBody[]).toHaveLength(
        1,
      );
    });

    it('only an uploaded letter has a visibility switch', async () => {
      const personal = await request(app.getHttpServer())
        .post(`/employees/${empId}/documents`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({
          docType: 'Driving Licence',
          fileName: 'dl.pdf',
          fileUrl: 'documents/dl.pdf',
        })
        .expect(201);
      await request(app.getHttpServer())
        .patch(
          `/employees/${empId}/documents/${(personal.body as DocumentBody).id}/visibility`,
        )
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ visibleToEmployee: false })
        .expect(400);
    });

    // Regression: a double-submitted upload (same stored file, same docType)
    // used to create two independent rows when the requests raced.
    it('concurrent duplicate uploads of the same file create exactly one document', async () => {
      const payload = {
        docType: 'Passport',
        fileName: 'passport.pdf',
        fileUrl: 'documents/passport-dup.pdf',
      };
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer())
            .post(`/employees/${empId}/documents`)
            .set('Authorization', `Bearer ${empToken}`)
            .send(payload),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(4);
      const rows = await prisma.employeeDocument.count({
        where: { employeeId: empId, fileUrl: payload.fileUrl },
      });
      expect(rows).toBe(1);

      // A different file for the same docType is still accepted.
      await request(app.getHttpServer())
        .post(`/employees/${empId}/documents`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ ...payload, fileUrl: 'documents/passport-dup-2.pdf' })
        .expect(201);
    });

    it('the same file can be re-uploaded after the previous one was rejected', async () => {
      const payload = {
        docType: 'Voter ID',
        fileName: 'voter.pdf',
        fileUrl: 'documents/voter-resubmit.pdf',
      };
      const first = await request(app.getHttpServer())
        .post(`/employees/${empId}/documents`)
        .set('Authorization', `Bearer ${empToken}`)
        .send(payload)
        .expect(201);
      await request(app.getHttpServer())
        .patch(
          `/employees/${empId}/documents/${(first.body as DocumentBody).id}/review`,
        )
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'REJECTED', reason: 'Wrong file' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/employees/${empId}/documents`)
        .set('Authorization', `Bearer ${empToken}`)
        .send(payload)
        .expect(201);
    });
  });

  describe('assets', () => {
    let assetId: string;

    it('EMPLOYEE cannot allocate an asset (HR/Admin-only)', async () => {
      await request(app.getHttpServer())
        .post(`/employees/${empId}/assets`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({
          assetType: 'Laptop',
          assetName: 'MacBook Pro',
          allocatedDate: '2026-01-10',
        })
        .expect(403);
    });

    it('HR allocates an asset to the employee', async () => {
      const res = await request(app.getHttpServer())
        .post(`/employees/${empId}/assets`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          assetType: 'Laptop',
          assetName: 'MacBook Pro',
          allocatedDate: '2026-01-10',
        })
        .expect(201);
      const body = res.body as AssetBody;
      assetId = body.id;
      expect(body.status).toBe('ALLOCATED');
    });

    it('EMPLOYEE can list their own assets', async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${empId}/assets`)
        .set('Authorization', `Bearer ${empToken}`)
        .expect(200);
      expect((res.body as AssetBody[]).length).toBe(1);
    });

    it('EMPLOYEE cannot view another employee assets', async () => {
      await request(app.getHttpServer())
        .get(`/employees/${otherEmpId}/assets`)
        .set('Authorization', `Bearer ${empToken}`)
        .expect(403);
    });

    it('marking RETURNED without returnedDate is rejected', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'RETURNED' })
        .expect(400);
    });

    it('HR marks the asset RETURNED with a returnedDate, recording returnedById', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${empId}/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'RETURNED', returnedDate: '2026-02-01' })
        .expect(200);
      const body = res.body as AssetBody;
      expect(body.status).toBe('RETURNED');
      expect(body.returnedDate).toBe('2026-02-01');
      expect(body.returnedById).not.toBeNull();
    });

    it('EMPLOYEE cannot update asset status (HR/Admin-only)', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/assets/${assetId}`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ status: 'LOST' })
        .expect(403);
    });

    // Regression: an allocation row only moves forward (ALLOCATED ->
    // RETURNED/LOST). Re-sending RETURNED used to re-run the inventory sync
    // and a RETURNED row could be reopened to ALLOCATED.
    it('re-sending RETURNED on an already-returned allocation is rejected (409)', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'RETURNED', returnedDate: '2026-03-01' })
        .expect(409);
      const row = await prisma.employeeAsset.findFirstOrThrow({
        where: { id: assetId },
      });
      // The original return is untouched.
      expect(row.returnedDate).toBe('2026-02-01');
    });

    it('a RETURNED allocation cannot be reopened to ALLOCATED or marked LOST (409)', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'ALLOCATED' })
        .expect(409);
      await request(app.getHttpServer())
        .patch(`/employees/${empId}/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'LOST' })
        .expect(409);
      const row = await prisma.employeeAsset.findFirstOrThrow({
        where: { id: assetId },
      });
      expect(row.status).toBe('RETURNED');
    });

    it('only one of several concurrent returns of the same allocation succeeds', async () => {
      const alloc = await request(app.getHttpServer())
        .post(`/employees/${otherEmpId}/assets`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          assetType: 'Headset',
          assetName: 'Concurrent Return Headset',
          allocatedDate: '2026-01-20',
        })
        .expect(201);
      const allocId = (alloc.body as AssetBody).id;

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          request(app.getHttpServer())
            .patch(`/employees/${otherEmpId}/assets/${allocId}`)
            .set('Authorization', `Bearer ${hrToken}`)
            .send({ status: 'RETURNED', returnedDate: `2026-02-0${i + 1}` }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(4);

      const returnedEvents = await prisma.auditLog.count({
        where: { action: 'ASSET_RETURNED', targetId: allocId },
      });
      expect(returnedEvents).toBe(1);
    });

    describe('duplicate assetTag', () => {
      it('HR allocates an asset with a tag', async () => {
        const res = await request(app.getHttpServer())
          .post(`/employees/${empId}/assets`)
          .set('Authorization', `Bearer ${hrToken}`)
          .send({
            assetType: 'Monitor',
            assetName: 'Dell 27"',
            assetTag: 'TAG-DUP-001',
            allocatedDate: '2026-01-15',
          })
          .expect(201);
        expect((res.body as AssetBody).assetTag).toBe('TAG-DUP-001');
      });

      it('allocating a second asset with the same tag in the same org is rejected (409)', async () => {
        const res = await request(app.getHttpServer())
          .post(`/employees/${otherEmpId}/assets`)
          .set('Authorization', `Bearer ${hrToken}`)
          .send({
            assetType: 'Monitor',
            assetName: 'Dell 27" (dup)',
            assetTag: 'TAG-DUP-001',
            allocatedDate: '2026-01-16',
          })
          .expect(409);
        expect((res.body as { message: string }).message).toMatch(
          /already exists/i,
        );
      });

      it('allocating multiple assets with no assetTag at all is allowed', async () => {
        await request(app.getHttpServer())
          .post(`/employees/${empId}/assets`)
          .set('Authorization', `Bearer ${hrToken}`)
          .send({
            assetType: 'Keyboard',
            assetName: 'Mechanical Keyboard',
            allocatedDate: '2026-01-17',
          })
          .expect(201);
        await request(app.getHttpServer())
          .post(`/employees/${otherEmpId}/assets`)
          .set('Authorization', `Bearer ${hrToken}`)
          .send({
            assetType: 'Keyboard',
            assetName: 'Mechanical Keyboard #2',
            allocatedDate: '2026-01-17',
          })
          .expect(201);
      });
    });

    describe('delete (soft)', () => {
      let deletableAssetId: string;

      beforeAll(async () => {
        const res = await request(app.getHttpServer())
          .post(`/employees/${empId}/assets`)
          .set('Authorization', `Bearer ${hrToken}`)
          .send({
            assetType: 'Mouse',
            assetName: 'Wireless Mouse',
            allocatedDate: '2026-01-18',
          })
          .expect(201);
        deletableAssetId = (res.body as AssetBody).id;
      });

      it('EMPLOYEE cannot delete an asset (HR/Admin-only)', async () => {
        await request(app.getHttpServer())
          .delete(`/employees/${empId}/assets/${deletableAssetId}`)
          .set('Authorization', `Bearer ${empToken}`)
          .expect(403);
      });

      it('HR soft-deletes an asset', async () => {
        await request(app.getHttpServer())
          .delete(`/employees/${empId}/assets/${deletableAssetId}`)
          .set('Authorization', `Bearer ${hrToken}`)
          .expect(200);
      });

      it('deleted asset no longer appears in listAssets', async () => {
        const res = await request(app.getHttpServer())
          .get(`/employees/${empId}/assets`)
          .set('Authorization', `Bearer ${hrToken}`)
          .expect(200);
        const ids = (res.body as AssetBody[]).map((a) => a.id);
        expect(ids).not.toContain(deletableAssetId);
      });

      it('deleting an already-deleted (or unknown) asset 404s', async () => {
        await request(app.getHttpServer())
          .delete(`/employees/${empId}/assets/${deletableAssetId}`)
          .set('Authorization', `Bearer ${hrToken}`)
          .expect(404);
      });
    });
  });
});
