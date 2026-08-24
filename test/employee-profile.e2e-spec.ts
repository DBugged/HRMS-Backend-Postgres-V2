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

    it('profileCompleted flips true once all 8 required fields are present, and stays stamped', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${empId}/personal-data`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({
          personalData: {
            gender: 'Female',
            currentAddress: '123 Main St',
            fatherName: 'John Doe',
            emergencyContact1Number: '+91 98765 43210',
            bankAccountNo: '123456789',
            bankIFSC: 'HDFC0001234',
          },
        })
        .expect(200);
      const personalData = (res.body as PersonalDataBody).personalData;
      expect(personalData.profileCompleted).toBe(true);
      expect(personalData.profileCompletedAt).not.toBeNull();
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
