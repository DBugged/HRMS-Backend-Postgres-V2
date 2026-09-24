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
interface OrgListItemBody {
  id: string;
  name: string;
  isSystemDefault: boolean;
}
interface AssetBody {
  id: string;
  assetCode: string;
  assetName: string;
  assetTag: string | null;
  serialNumber: string | null;
  status: string;
  condition: string;
  isActive: boolean;
  warrantyEndDate: string | null;
  categorySpecify: string | null;
  currentAssignment?: { id: string; employee: { id: string } } | null;
  maintenances?: { id: string }[];
  documents?: { id: string; fileUrl: string; docType: string }[];
}
interface ListBody<T> {
  data: T[];
  total: number;
}

const PASSWORD = 'TestPass123!';

describe('Asset Inventory (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
  let employeeId: string;

  let laptopCategoryId: string;
  let otherCategoryId: string;

  const validAsset = () => ({
    assetName: 'MacBook Air M2',
    categoryId: laptopCategoryId,
    purchasedFrom: 'Reliance Digital',
    purchaseDate: '2026-01-15',
    condition: 'NEW',
    status: 'AVAILABLE',
  });

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
      organizationName: 'Assets E2E Org',
      name: 'Founder',
      email: 'assets-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'assets-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'assets-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'assets-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Regular Employee',
        email: 'assets-e2e-emp@example.test',
        role: 'EMPLOYEE',
      });
    employeeId = (empCreate.body as EmployeeBody).employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'assets-e2e-emp@example.test',
        password: (empCreate.body as EmployeeBody).generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const categories = await request(app.getHttpServer())
      .get('/org-list-items')
      .query({ type: 'ASSET_CATEGORY' })
      .set('Authorization', `Bearer ${adminToken}`);
    const items = (categories.body as ListBody<OrgListItemBody>).data;
    laptopCategoryId = items.find((i) => i.name === 'Laptop')!.id;
    otherCategoryId = items.find((i) => i.name === 'Other')!.id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "asset_documents", "asset_maintenances", "employee_assets", "assets", "org_list_items", "audit_logs", "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  describe('asset categories come from the shared org-list-items master', () => {
    it('a newly-registered org is seeded with the built-in ASSET_CATEGORY list, including "Other"', () => {
      expect(laptopCategoryId).toBeTruthy();
      expect(otherCategoryId).toBeTruthy();
    });
  });

  describe('create + list + get', () => {
    let assetId: string;

    it('HR creates an asset, and the asset code is auto-generated', async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          ...validAsset(),
          assetTag: 'TAG-001',
          serialNumber: 'SN-001',
          brand: 'Apple',
          model: 'A2681',
          purchaseCost: 95000,
          location: 'Mumbai HQ',
        })
        .expect(201);
      const body = res.body as AssetBody;
      assetId = body.id;
      expect(body.assetCode).toMatch(/^AST-\d{4}$/);
      expect(body.status).toBe('AVAILABLE');
      expect(body.isActive).toBe(true);
    });

    it('a duplicate assetTag in the same org is a 409', async () => {
      await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ ...validAsset(), assetTag: 'TAG-001' })
        .expect(409);
    });

    it('a duplicate serialNumber in the same org is a 409', async () => {
      await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ ...validAsset(), serialNumber: 'SN-001' })
        .expect(409);
    });

    // Regression guard for the empty-string-vs-NULL trap EmployeeAsset.assetTag
    // already documents — '' is NOT exempt from a Postgres unique index.
    it('two assets with no tag or serial at all are both allowed', async () => {
      await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ ...validAsset(), assetTag: '', serialNumber: '' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ ...validAsset(), assetTag: '', serialNumber: '' })
        .expect(201);
    });

    it('warranty end date before start date is a 400', async () => {
      await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          ...validAsset(),
          warrantyStartDate: '2026-06-10',
          warrantyEndDate: '2026-01-01',
        })
        .expect(400);
    });

    it('a negative purchaseCost is a 400', async () => {
      await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ ...validAsset(), purchaseCost: -1 })
        .expect(400);
    });

    it('category "Other" requires the Specify Asset field', async () => {
      await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ ...validAsset(), categoryId: otherCategoryId })
        .expect(400);

      const ok = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          ...validAsset(),
          categoryId: otherCategoryId,
          categorySpecify: 'Projector',
        })
        .expect(201);
      expect((ok.body as AssetBody).categorySpecify).toBe('Projector');
    });

    it('HR lists assets, org-scoped', async () => {
      const res = await request(app.getHttpServer())
        .get('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const body = res.body as ListBody<AssetBody>;
      expect(body.total).toBeGreaterThanOrEqual(4);
      expect(body.data.some((a) => a.id === assetId)).toBe(true);
    });

    it('HR gets one asset with category/maintenance/documents/currentAssignment', async () => {
      const res = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const body = res.body as AssetBody;
      expect(Array.isArray(body.maintenances)).toBe(true);
      expect(Array.isArray(body.documents)).toBe(true);
      expect(body.currentAssignment).toBeNull();
    });

    it('an EMPLOYEE has no access to the assets module at all', async () => {
      await request(app.getHttpServer())
        .get('/assets')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send(validAsset())
        .expect(403);
    });

    it('HR updates an asset and the change is diffed into the audit trail', async () => {
      await request(app.getHttpServer())
        .patch(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ location: 'Pune Office', remarks: 'Moved offices' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/assets/${assetId}/history`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const entries = (
        res.body as ListBody<{
          action: string;
          details: { changes?: Record<string, unknown> };
        }>
      ).data;
      const updateEntry = entries.find((e) => e.action === 'ASSET_UPDATED');
      expect(updateEntry).toBeDefined();
      expect(Object.keys(updateEntry!.details.changes ?? {})).toContain(
        'location',
      );
      // Newest first, and the create entry is still there behind it.
      expect(entries[entries.length - 1].action).toBe('ASSET_CREATED');
    });

    it('an update that collides with another asset tag is a 409', async () => {
      const other = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ ...validAsset(), assetTag: 'TAG-999' })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/assets/${(other.body as AssetBody).id}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ assetTag: 'TAG-001' })
        .expect(409);
    });
  });

  describe('status changes', () => {
    let assetId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send(validAsset())
        .expect(201);
      assetId = (res.body as AssetBody).id;
    });

    it('HR can move an asset to UNDER_MAINTENANCE and back to AVAILABLE', async () => {
      const toMaintenance = await request(app.getHttpServer())
        .patch(`/assets/${assetId}/status`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'UNDER_MAINTENANCE' })
        .expect(200);
      expect((toMaintenance.body as AssetBody).status).toBe(
        'UNDER_MAINTENANCE',
      );

      const back = await request(app.getHttpServer())
        .patch(`/assets/${assetId}/status`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'AVAILABLE' })
        .expect(200);
      expect((back.body as AssetBody).status).toBe('AVAILABLE');
    });

    it('HR cannot retire or dispose of an asset — Admin only', async () => {
      await request(app.getHttpServer())
        .patch(`/assets/${assetId}/status`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'RETIRED' })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/assets/${assetId}/status`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'DISPOSED' })
        .expect(403);
    });

    it('ADMIN can retire an asset', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/assets/${assetId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'RETIRED' })
        .expect(200);
      expect((res.body as AssetBody).status).toBe('RETIRED');
    });

    it('ASSIGNED cannot be set by hand — it only comes from an allocation', async () => {
      await request(app.getHttpServer())
        .patch(`/assets/${assetId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'ASSIGNED' })
        .expect(400);
    });
  });

  describe('warranty', () => {
    let assetId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send(validAsset())
        .expect(201);
      assetId = (res.body as AssetBody).id;
    });

    it('HR updates warranty details', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/assets/${assetId}/warranty`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          warrantyProvider: 'Apple Care',
          warrantyNumber: 'AC-123',
          warrantyStartDate: '2026-01-15',
          warrantyEndDate: '2028-01-14',
          warrantyPeriodMonths: 24,
          supportEmail: 'support@example.test',
        })
        .expect(200);
      expect((res.body as AssetBody).warrantyEndDate).toContain('2028-01-14');
    });

    it('an inverted warranty range is a 400, including when only one side is edited', async () => {
      await request(app.getHttpServer())
        .patch(`/assets/${assetId}/warranty`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ warrantyEndDate: '2025-01-01' })
        .expect(400);
    });

    it('the warranty update is audited', async () => {
      const res = await request(app.getHttpServer())
        .get(`/assets/${assetId}/history`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const actions = (res.body as ListBody<{ action: string }>).data.map(
        (e) => e.action,
      );
      expect(actions).toContain('ASSET_WARRANTY_UPDATED');
    });
  });

  describe('maintenance', () => {
    let assetId: string;
    let maintenanceId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send(validAsset())
        .expect(201);
      assetId = (res.body as AssetBody).id;
    });

    it('HR adds a maintenance record', async () => {
      const res = await request(app.getHttpServer())
        .post(`/assets/${assetId}/maintenance`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          serviceDate: '2026-03-01',
          issue: 'Battery replacement',
          serviceProvider: 'Apple Service Center',
          serviceCost: 8000,
        })
        .expect(201);
      const body = res.body as { id: string; serviceStatus: string };
      maintenanceId = body.id;
      expect(body.serviceStatus).toBe('SCHEDULED');
    });

    it('HR updates the maintenance record to COMPLETED', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/assets/${assetId}/maintenance/${maintenanceId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          serviceStatus: 'COMPLETED',
          serviceCompletionDate: '2026-03-05',
          nextServiceDate: '2026-09-01',
        })
        .expect(200);
      expect((res.body as { serviceStatus: string }).serviceStatus).toBe(
        'COMPLETED',
      );
    });

    it('the maintenance record shows up on the asset detail', async () => {
      const res = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect((res.body as AssetBody).maintenances).toHaveLength(1);
    });

    it('an EMPLOYEE cannot add maintenance', async () => {
      await request(app.getHttpServer())
        .post(`/assets/${assetId}/maintenance`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ serviceDate: '2026-03-01', issue: 'nope' })
        .expect(403);
    });
  });

  describe('documents', () => {
    let assetId: string;
    let docId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send(validAsset())
        .expect(201);
      assetId = (res.body as AssetBody).id;
    });

    it('HR records an uploaded document against the asset', async () => {
      const res = await request(app.getHttpServer())
        .post(`/assets/${assetId}/documents`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          docType: 'INVOICE',
          fileName: 'invoice.pdf',
          relativeKey: 'documents/assets-e2e/invoice.pdf',
        })
        .expect(201);
      const body = res.body as { id: string; fileUrl: string };
      docId = body.id;
      // The durable relativeKey is signed on the way out, never returned raw.
      expect(body.fileUrl.startsWith('/files/')).toBe(true);
    });

    it('the document is listed on the asset detail', async () => {
      const res = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const docs = (res.body as AssetBody).documents!;
      expect(docs).toHaveLength(1);
      expect(docs[0].docType).toBe('INVOICE');
      expect(docs[0].fileUrl.startsWith('/files/')).toBe(true);
    });

    it('HR deletes the document', async () => {
      await request(app.getHttpServer())
        .delete(`/assets/${assetId}/documents/${docId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect((res.body as AssetBody).documents).toHaveLength(0);
    });

    it('both document actions are audited', async () => {
      const res = await request(app.getHttpServer())
        .get(`/assets/${assetId}/history`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const actions = (res.body as ListBody<{ action: string }>).data.map(
        (e) => e.action,
      );
      expect(actions).toContain('ASSET_DOCUMENT_ADDED');
      expect(actions).toContain('ASSET_DOCUMENT_REMOVED');
    });
  });

  describe('soft delete', () => {
    let assetId: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send(validAsset())
        .expect(201);
      assetId = (res.body as AssetBody).id;
    });

    it('HR cannot soft-delete an asset — Admin only', async () => {
      await request(app.getHttpServer())
        .delete(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(403);
    });

    it('ADMIN soft-deletes an asset and it drops out of the list but keeps its row', async () => {
      await request(app.getHttpServer())
        .delete(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const list = await request(app.getHttpServer())
        .get('/assets')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(
        (list.body as ListBody<AssetBody>).data.some((a) => a.id === assetId),
      ).toBe(false);

      const stillThere = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((stillThere.body as AssetBody).isActive).toBe(false);
    });
  });

  // The link between this module and the Employees module's existing
  // allocation endpoints: allocating with `assetId` flips inventory status,
  // returning flips it back. The inventory module itself exposes no
  // assign/return action at all.
  describe('assignment integration (Employees module owns assignment)', () => {
    let assetId: string;
    let allocationId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ ...validAsset(), assetTag: 'TAG-LINKED' })
        .expect(201);
      assetId = (res.body as AssetBody).id;
    });

    it('allocating with assetId flips the inventory record to ASSIGNED and copies its details down', async () => {
      const alloc = await request(app.getHttpServer())
        .post(`/employees/${employeeId}/assets`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          assetId,
          assetType: 'ignored-free-text',
          assetName: 'ignored-free-text',
          allocatedDate: '2026-04-01',
        })
        .expect(201);
      const body = alloc.body as {
        id: string;
        assetType: string;
        assetName: string;
        assetTag: string | null;
      };
      allocationId = body.id;
      expect(body.assetType).toBe('Laptop');
      expect(body.assetName).toBe('MacBook Air M2');
      expect(body.assetTag).toBe('TAG-LINKED');

      const asset = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect((asset.body as AssetBody).status).toBe('ASSIGNED');
      expect((asset.body as AssetBody).currentAssignment?.employee.id).toBe(
        employeeId,
      );
    });

    it('an asset that is already assigned cannot be allocated again', async () => {
      await request(app.getHttpServer())
        .post(`/employees/${employeeId}/assets`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          assetId,
          assetType: 'Laptop',
          assetName: 'MacBook Air M2',
          allocatedDate: '2026-04-02',
        })
        .expect(400);
    });

    it('an assigned asset cannot be soft-deleted until it is returned', async () => {
      await request(app.getHttpServer())
        .delete(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('returning the allocation flips the inventory record back to AVAILABLE', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${employeeId}/assets/${allocationId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'RETURNED', returnedDate: '2026-05-01' })
        .expect(200);

      const asset = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect((asset.body as AssetBody).status).toBe('AVAILABLE');
      expect((asset.body as AssetBody).currentAssignment).toBeNull();
    });

    it('marking a linked allocation LOST flips the inventory record to LOST', async () => {
      const alloc = await request(app.getHttpServer())
        .post(`/employees/${employeeId}/assets`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          assetId,
          assetType: 'Laptop',
          assetName: 'MacBook Air M2',
          allocatedDate: '2026-06-01',
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(
          `/employees/${employeeId}/assets/${(alloc.body as { id: string }).id}`,
        )
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'LOST' })
        .expect(200);

      const asset = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect((asset.body as AssetBody).status).toBe('LOST');
    });

    // The whole point of assetId being optional: the pre-inventory
    // free-text allocation flow must behave exactly as it always has.
    it('allocating WITHOUT assetId still works unchanged and touches no inventory record', async () => {
      const before = await request(app.getHttpServer())
        .get('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);

      const alloc = await request(app.getHttpServer())
        .post(`/employees/${employeeId}/assets`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          assetType: 'Headset',
          assetName: 'Jabra Evolve 20',
          assetTag: 'FREE-TEXT-1',
          allocatedDate: '2026-07-01',
        })
        .expect(201);
      const body = alloc.body as {
        assetType: string;
        assetName: string;
        assetTag: string;
        assetId: string | null;
      };
      expect(body.assetType).toBe('Headset');
      expect(body.assetName).toBe('Jabra Evolve 20');
      expect(body.assetTag).toBe('FREE-TEXT-1');
      expect(body.assetId).toBeNull();

      const after = await request(app.getHttpServer())
        .get('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect(
        (after.body as ListBody<AssetBody>).data.map((a) => a.status),
      ).toEqual((before.body as ListBody<AssetBody>).data.map((a) => a.status));
    });
  });

  describe('create-time status rules', () => {
    it('ASSIGNED cannot be set on create', async () => {
      await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validAsset(), status: 'ASSIGNED' })
        .expect(400);
    });

    it('HR cannot create an asset directly as RETIRED or DISPOSED', async () => {
      for (const status of ['RETIRED', 'DISPOSED']) {
        await request(app.getHttpServer())
          .post('/assets')
          .set('Authorization', `Bearer ${hrToken}`)
          .send({ ...validAsset(), status })
          .expect(403);
      }
    });

    it('ADMIN can create an asset as RETIRED', async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validAsset(), status: 'RETIRED' })
        .expect(201);
      expect((res.body as AssetBody).status).toBe('RETIRED');
    });
  });

  describe('soft-deleted assets are read-only', () => {
    let assetId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send(validAsset())
        .expect(201);
      assetId = (res.body as AssetBody).id;
      await request(app.getHttpServer())
        .delete(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('every mutation 404s against a soft-deleted asset', async () => {
      const server = app.getHttpServer();
      const auth = `Bearer ${adminToken}`;
      await request(server)
        .patch(`/assets/${assetId}`)
        .set('Authorization', auth)
        .send({ location: 'x' })
        .expect(404);
      await request(server)
        .patch(`/assets/${assetId}/status`)
        .set('Authorization', auth)
        .send({ status: 'UNDER_MAINTENANCE' })
        .expect(404);
      await request(server)
        .patch(`/assets/${assetId}/warranty`)
        .set('Authorization', auth)
        .send({ warrantyProvider: 'x' })
        .expect(404);
      await request(server)
        .post(`/assets/${assetId}/maintenance`)
        .set('Authorization', auth)
        .send({ serviceDate: '2026-03-01', issue: 'x' })
        .expect(404);
      await request(server)
        .post(`/assets/${assetId}/documents`)
        .set('Authorization', auth)
        .send({
          docType: 'INVOICE',
          fileName: 'a.pdf',
          relativeKey: 'documents/assets-e2e/a.pdf',
        })
        .expect(404);
    });

    it('a repeat delete is still a 400, and detail/history stay readable', async () => {
      const server = app.getHttpServer();
      await request(server)
        .delete(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
      await request(server)
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      await request(server)
        .get(`/assets/${assetId}/history`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });
  });

  describe('list pagination + search', () => {
    it('honours page/limit and reports the real total', async () => {
      const res = await request(app.getHttpServer())
        .get('/assets')
        .query({ page: 1, limit: 2 })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const body = res.body as ListBody<AssetBody> & {
        page: number;
        limit: number;
      };
      expect(body.data).toHaveLength(2);
      expect(body.total).toBeGreaterThan(2);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(2);

      const page2 = await request(app.getHttpServer())
        .get('/assets')
        .query({ page: 2, limit: 2 })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const ids1 = body.data.map((a) => a.id);
      for (const a of (page2.body as ListBody<AssetBody>).data) {
        expect(ids1).not.toContain(a.id);
      }
    });

    it('rejects out-of-range page/limit', async () => {
      for (const query of [{ limit: 0 }, { limit: 5000 }, { page: 0 }]) {
        await request(app.getHttpServer())
          .get('/assets')
          .query(query)
          .set('Authorization', `Bearer ${hrToken}`)
          .expect(400);
      }
    });

    it('% and _ in search are literals, not LIKE wildcards', async () => {
      await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ ...validAsset(), assetName: 'Wild_Card 100% Monitor' })
        .expect(201);

      const pct = await request(app.getHttpServer())
        .get('/assets')
        .query({ search: '%', limit: 2000 })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const pctNames = (pct.body as ListBody<AssetBody>).data.map(
        (a) => a.assetName,
      );
      expect(pctNames).toEqual(['Wild_Card 100% Monitor']);

      const underscore = await request(app.getHttpServer())
        .get('/assets')
        .query({ search: 'd_c', limit: 2000 })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect(
        (underscore.body as ListBody<AssetBody>).data.map((a) => a.assetName),
      ).toEqual(['Wild_Card 100% Monitor']);

      // "M_cBook" would match "MacBook" if _ were a wildcard.
      const noWild = await request(app.getHttpServer())
        .get('/assets')
        .query({ search: 'M_cBook' })
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect((noWild.body as ListBody<AssetBody>).total).toBe(0);
    });
  });

  describe('stale ASSIGNED recovery + allocation history', () => {
    let assetId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send(validAsset())
        .expect(201);
      assetId = (res.body as AssetBody).id;
    });

    const allocate = (date: string) =>
      request(app.getHttpServer())
        .post(`/employees/${employeeId}/assets`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          assetId,
          assetType: 'Laptop',
          assetName: 'MacBook Air M2',
          allocatedDate: date,
        });

    it('removing the allocation row leaves a recoverable ASSIGNED, and history shows allocation events', async () => {
      const alloc = await allocate('2026-08-01').expect(201);
      await request(app.getHttpServer())
        .delete(
          `/employees/${employeeId}/assets/${(alloc.body as { id: string }).id}`,
        )
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);

      const history = await request(app.getHttpServer())
        .get(`/assets/${assetId}/history`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      const actions = (history.body as ListBody<{ action: string }>).data.map(
        (e) => e.action,
      );
      expect(actions).toContain('ASSET_ALLOCATED');
      expect(actions).toContain('ASSET_CREATED');

      // Stale ASSIGNED with no live allocation behind it — HR can now
      // move it back to AVAILABLE instead of it being stuck forever.
      await request(app.getHttpServer())
        .patch(`/assets/${assetId}/status`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'AVAILABLE' })
        .expect(200);

      // ...and it can be allocated again.
      const again = await allocate('2026-08-02').expect(201);
      // A LIVE allocation still blocks status changes and deletes.
      await request(app.getHttpServer())
        .patch(`/assets/${assetId}/status`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'UNDER_MAINTENANCE' })
        .expect(400);
      await request(app.getHttpServer())
        .delete(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);

      await request(app.getHttpServer())
        .delete(
          `/employees/${employeeId}/assets/${(again.body as { id: string }).id}`,
        )
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);

      // Stale ASSIGNED no longer blocks a delete, and the status is corrected.
      await request(app.getHttpServer())
        .delete(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const after = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((after.body as AssetBody).isActive).toBe(false);
      expect((after.body as AssetBody).status).toBe('AVAILABLE');
    });
  });

  describe('concurrent allocation', () => {
    it('only one of several simultaneous allocations of the same asset succeeds', async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send(validAsset())
        .expect(201);
      const assetId = (res.body as AssetBody).id;

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          request(app.getHttpServer())
            .post(`/employees/${employeeId}/assets`)
            .set('Authorization', `Bearer ${hrToken}`)
            .send({
              assetId,
              assetType: 'Laptop',
              assetName: 'MacBook Air M2',
              allocatedDate: `2026-09-0${i + 1}`,
            }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      for (const s of statuses) expect([201, 400, 409]).toContain(s);

      const liveRows = await prisma.employeeAsset.count({
        where: { assetId, isActive: true, status: 'ALLOCATED' },
      });
      expect(liveRows).toBe(1);
    });
  });

  // Regression: re-sending RETURNED on an old, already-returned allocation
  // flipped the inventory asset back to AVAILABLE even though it had since
  // been re-allocated — letting it be allocated again (one asset ended up
  // ALLOCATED to three employees).
  describe('stale return of an old allocation', () => {
    it('cannot free an asset now held by a newer allocation', async () => {
      const res = await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${hrToken}`)
        .send(validAsset())
        .expect(201);
      const assetId = (res.body as AssetBody).id;
      const allocate = async (date: string) =>
        (
          (
            await request(app.getHttpServer())
              .post(`/employees/${employeeId}/assets`)
              .set('Authorization', `Bearer ${hrToken}`)
              .send({
                assetId,
                assetType: 'Laptop',
                assetName: 'MacBook Air M2',
                allocatedDate: date,
              })
              .expect(201)
          ).body as { id: string }
        ).id;

      const first = await allocate('2026-07-01');
      await request(app.getHttpServer())
        .patch(`/employees/${employeeId}/assets/${first}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'RETURNED', returnedDate: '2026-07-10' })
        .expect(200);
      const second = await allocate('2026-07-11');

      // Replaying the first allocation's return (and trying to reopen it).
      await request(app.getHttpServer())
        .patch(`/employees/${employeeId}/assets/${first}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'RETURNED', returnedDate: '2026-07-12' })
        .expect(409);
      await request(app.getHttpServer())
        .patch(`/employees/${employeeId}/assets/${first}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'ALLOCATED' })
        .expect(409);

      const asset = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect((asset.body as AssetBody).status).toBe('ASSIGNED');

      // So it still can't be allocated a second time.
      await request(app.getHttpServer())
        .post(`/employees/${employeeId}/assets`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          assetId,
          assetType: 'Laptop',
          assetName: 'MacBook Air M2',
          allocatedDate: '2026-07-13',
        })
        .expect(400);
      expect(
        await prisma.employeeAsset.count({
          where: { assetId, isActive: true, status: 'ALLOCATED' },
        }),
      ).toBe(1);

      // Returning the current allocation does free it.
      await request(app.getHttpServer())
        .patch(`/employees/${employeeId}/assets/${second}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ status: 'RETURNED', returnedDate: '2026-07-20' })
        .expect(200);
      const after = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);
      expect((after.body as AssetBody).status).toBe('AVAILABLE');
    });
  });

  describe('bulk import', () => {
    it('creates rows by resolving Category by name, and reports per-row errors', async () => {
      const res = await request(app.getHttpServer())
        .post('/assets/bulk-import')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          rows: [
            {
              assetName: 'Bulk Laptop 1',
              category: 'laptop',
              purchasedFrom: 'Croma',
              purchaseDate: '2026-02-01',
              condition: 'good',
              status: 'available',
            },
            {
              assetName: 'Bulk Laptop 2',
              category: 'Nonexistent Category',
              purchasedFrom: 'Croma',
              purchaseDate: '2026-02-01',
            },
            {
              assetName: '',
              category: 'Laptop',
              purchasedFrom: 'Croma',
              purchaseDate: '2026-02-01',
            },
          ],
        })
        .expect(201);
      const body = res.body as {
        created: string[];
        skipped: { name: string; reason: string }[];
      };
      expect(body.created).toEqual(['Bulk Laptop 1']);
      expect(body.skipped).toHaveLength(2);
      expect(body.skipped[0].reason).toContain('Nonexistent Category');

      const created = await prisma.asset.findFirst({
        where: { assetName: 'Bulk Laptop 1' },
      });
      expect(created?.condition).toBe('GOOD');
      expect(created?.status).toBe('AVAILABLE');
      expect(created?.categoryId).toBe(laptopCategoryId);
    });

    it('403s for EMPLOYEE', async () => {
      await request(app.getHttpServer())
        .post('/assets/bulk-import')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ rows: [] })
        .expect(403);
    });
  });
});
