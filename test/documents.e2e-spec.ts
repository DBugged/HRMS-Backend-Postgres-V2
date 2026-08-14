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
interface PolicyBody {
  id: string;
  fileUrl: string;
  version: number;
  previousVersionId: string | null;
  isPublished: boolean;
}
interface RequirementBody {
  id: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
}

const PASSWORD = 'TestPass123!';

describe('Documents (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let deptId: string;
  let deptEmployeeToken: string;
  let outsideEmployeeToken: string;
  let outsideEmployeeId: string;

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
      organizationName: 'Documents E2E Org',
      name: 'Founder',
      email: 'doc-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'doc-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'doc-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'doc-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const mgrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Manager',
        email: 'doc-e2e-mgr@example.test',
        role: 'MANAGER',
      });
    const mgrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'doc-e2e-mgr@example.test',
        password: (mgrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (mgrLogin.body as AuthBody).accessToken;

    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Engineering', code: 'ENG' });
    deptId = (dept.body as { id: string }).id;

    const deptEmpCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Dept Employee',
        email: 'doc-e2e-dept-emp@example.test',
        departmentId: deptId,
      });
    const deptEmpBody = deptEmpCreate.body as EmployeeCreateBody;
    const deptEmpLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'doc-e2e-dept-emp@example.test',
        password: deptEmpBody.generatedPassword,
      });
    deptEmployeeToken = (deptEmpLogin.body as AuthBody).accessToken;

    const outsideEmpCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Outside Employee',
        email: 'doc-e2e-outside-emp@example.test',
      });
    const outsideEmpBody = outsideEmpCreate.body as EmployeeCreateBody;
    outsideEmployeeId = outsideEmpBody.employee.id;
    const outsideEmpLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'doc-e2e-outside-emp@example.test',
        password: outsideEmpBody.generatedPassword,
      });
    outsideEmployeeToken = (outsideEmpLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "policy_documents", "document_requirements", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403 creating a policy document', async () => {
    await request(app.getHttpServer())
      .post('/documents/policies')
      .set('Authorization', `Bearer ${outsideEmployeeToken}`)
      .send({
        title: 'Leave Policy',
        fileUrl: '00000000-0000-0000-0000-000000000000/documents/x.pdf',
        fileName: 'leave.pdf',
      })
      .expect(403);
  });

  it('rejects create with docType URL but a non-http fileUrl', async () => {
    await request(app.getHttpServer())
      .post('/documents/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'External Policy',
        docType: 'URL',
        fileUrl: 'not-a-url',
        fileName: 'external',
      })
      .expect(400);
  });

  let everyonePolicyId: string;

  it('HR creates a published policy visible to everyone', async () => {
    const res = await request(app.getHttpServer())
      .post('/documents/policies')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        title: 'Code of Conduct',
        category: 'HR',
        fileUrl: '00000000-0000-0000-0000-000000000000/documents/coc.pdf',
        fileName: 'coc.pdf',
      })
      .expect(201);
    const body = res.body as PolicyBody;
    everyonePolicyId = body.id;
    expect(body.version).toBe(1);
    expect(body.previousVersionId).toBeNull();
    // Signed into a /files/<token> URL, not the raw relative key.
    expect(body.fileUrl).toMatch(/^\/files\//);
  });

  it('any authenticated employee sees the everyone-visible published policy', async () => {
    const res = await request(app.getHttpServer())
      .get('/documents/policies')
      .set('Authorization', `Bearer ${outsideEmployeeToken}`)
      .expect(200);
    const body = res.body as PolicyBody[];
    expect(body.some((p) => p.id === everyonePolicyId)).toBe(true);
  });

  let unpublishedPolicyId: string;

  it('a draft (unpublished) policy is hidden from a plain employee but visible to HR', async () => {
    const created = await request(app.getHttpServer())
      .post('/documents/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Draft Policy',
        fileUrl: '00000000-0000-0000-0000-000000000000/documents/draft.pdf',
        fileName: 'draft.pdf',
        isPublished: false,
      })
      .expect(201);
    unpublishedPolicyId = (created.body as PolicyBody).id;

    const employeeView = await request(app.getHttpServer())
      .get('/documents/policies')
      .set('Authorization', `Bearer ${outsideEmployeeToken}`)
      .expect(200);
    expect(
      (employeeView.body as PolicyBody[]).some(
        (p) => p.id === unpublishedPolicyId,
      ),
    ).toBe(false);

    const hrView = await request(app.getHttpServer())
      .get('/documents/policies')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    expect(
      (hrView.body as PolicyBody[]).some((p) => p.id === unpublishedPolicyId),
    ).toBe(true);
  });

  it('DEPARTMENTS visibility: only the targeted department sees it', async () => {
    await request(app.getHttpServer())
      .post('/documents/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Engineering Handbook',
        fileUrl: '00000000-0000-0000-0000-000000000000/documents/eng.pdf',
        fileName: 'eng.pdf',
        visibility: 'DEPARTMENTS',
        visibleDepartments: [deptId],
      })
      .expect(201);

    const deptView = await request(app.getHttpServer())
      .get('/documents/policies')
      .set('Authorization', `Bearer ${deptEmployeeToken}`)
      .expect(200);
    expect(
      (deptView.body as { title: string }[]).some(
        (p) => p.title === 'Engineering Handbook',
      ),
    ).toBe(true);

    const outsideView = await request(app.getHttpServer())
      .get('/documents/policies')
      .set('Authorization', `Bearer ${outsideEmployeeToken}`)
      .expect(200);
    expect(
      (outsideView.body as { title: string }[]).some(
        (p) => p.title === 'Engineering Handbook',
      ),
    ).toBe(false);
  });

  it('EMPLOYEES visibility: only the named employees see it', async () => {
    await request(app.getHttpServer())
      .post('/documents/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Personal Offer Letter',
        fileUrl: '00000000-0000-0000-0000-000000000000/documents/offer.pdf',
        fileName: 'offer.pdf',
        visibility: 'EMPLOYEES',
        visibleEmployees: [outsideEmployeeId],
      })
      .expect(201);

    const named = await request(app.getHttpServer())
      .get('/documents/policies')
      .set('Authorization', `Bearer ${outsideEmployeeToken}`)
      .expect(200);
    expect(
      (named.body as { title: string }[]).some(
        (p) => p.title === 'Personal Offer Letter',
      ),
    ).toBe(true);

    const other = await request(app.getHttpServer())
      .get('/documents/policies')
      .set('Authorization', `Bearer ${deptEmployeeToken}`)
      .expect(200);
    expect(
      (other.body as { title: string }[]).some(
        (p) => p.title === 'Personal Offer Letter',
      ),
    ).toBe(false);
  });

  it('MANAGERS visibility: manager can see, plain employee cannot', async () => {
    await request(app.getHttpServer())
      .post('/documents/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Manager Playbook',
        fileUrl: '00000000-0000-0000-0000-000000000000/documents/mgr.pdf',
        fileName: 'mgr.pdf',
        visibility: 'MANAGERS',
      })
      .expect(201);

    const mgrView = await request(app.getHttpServer())
      .get('/documents/policies')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(
      (mgrView.body as { title: string }[]).some(
        (p) => p.title === 'Manager Playbook',
      ),
    ).toBe(true);

    const empView = await request(app.getHttpServer())
      .get('/documents/policies')
      .set('Authorization', `Bearer ${outsideEmployeeToken}`)
      .expect(200);
    expect(
      (empView.body as { title: string }[]).some(
        (p) => p.title === 'Manager Playbook',
      ),
    ).toBe(false);
  });

  it('publishing a new version chains via previousVersionId and retires the old row', async () => {
    const v2 = await request(app.getHttpServer())
      .post('/documents/policies')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        replacesId: everyonePolicyId,
        fileUrl: '00000000-0000-0000-0000-000000000000/documents/coc-v2.pdf',
        fileName: 'coc-v2.pdf',
      })
      .expect(201);
    const v2Body = v2.body as PolicyBody;
    expect(v2Body.version).toBe(2);
    expect(v2Body.previousVersionId).toBe(everyonePolicyId);

    const versions = await request(app.getHttpServer())
      .get(`/documents/policies/${everyonePolicyId}/versions`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    const chain = versions.body as PolicyBody[];
    expect(chain).toHaveLength(2);
    expect(chain[0].id).toBe(v2Body.id);
    expect(chain[0].isPublished).toBe(true);
    expect(chain[1].id).toBe(everyonePolicyId);
    expect(chain[1].isPublished).toBe(false);
  });

  it('EMPLOYEE gets 403 fetching version history', async () => {
    await request(app.getHttpServer())
      .get(`/documents/policies/${everyonePolicyId}/versions`)
      .set('Authorization', `Bearer ${outsideEmployeeToken}`)
      .expect(403);
  });

  it('PATCH toggles isPublished (publish/unpublish)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/documents/policies/${unpublishedPolicyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isPublished: true })
      .expect(200);
    expect((res.body as PolicyBody).isPublished).toBe(true);

    const employeeView = await request(app.getHttpServer())
      .get('/documents/policies')
      .set('Authorization', `Bearer ${outsideEmployeeToken}`)
      .expect(200);
    expect(
      (employeeView.body as PolicyBody[]).some(
        (p) => p.id === unpublishedPolicyId,
      ),
    ).toBe(true);
  });

  it('DELETE removes the policy', async () => {
    await request(app.getHttpServer())
      .delete(`/documents/policies/${unpublishedPolicyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const hrView = await request(app.getHttpServer())
      .get('/documents/policies')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
    expect(
      (hrView.body as PolicyBody[]).some((p) => p.id === unpublishedPolicyId),
    ).toBe(false);
  });

  it('404s deleting a non-existent policy', async () => {
    await request(app.getHttpServer())
      .delete('/documents/policies/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  // -- Document requirements --

  it('EMPLOYEE gets 403 creating a document requirement', async () => {
    await request(app.getHttpServer())
      .post('/documents/requirements')
      .set('Authorization', `Bearer ${outsideEmployeeToken}`)
      .send({ name: 'NDA' })
      .expect(403);
  });

  let requirementId: string;

  it('HR creates a document requirement, defaulting displayOrder to the current count', async () => {
    const res = await request(app.getHttpServer())
      .post('/documents/requirements')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ name: 'NDA', isMandatory: true })
      .expect(201);
    const body = res.body as RequirementBody;
    requirementId = body.id;
    expect(body.displayOrder).toBe(0);
  });

  it('any authenticated employee can list requirements', async () => {
    const res = await request(app.getHttpServer())
      .get('/documents/requirements')
      .set('Authorization', `Bearer ${outsideEmployeeToken}`)
      .expect(200);
    expect(
      (res.body as RequirementBody[]).some((r) => r.id === requirementId),
    ).toBe(true);
  });

  it('PATCH toggles isActive (soft-disable)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/documents/requirements/${requirementId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false })
      .expect(200);
    expect((res.body as RequirementBody).isActive).toBe(false);
  });

  it('404s updating a non-existent requirement', async () => {
    await request(app.getHttpServer())
      .patch('/documents/requirements/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'X' })
      .expect(404);
  });
});
