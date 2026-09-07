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
interface SendResultBody {
  message: string;
}

const PASSWORD = 'TestPass123!';

describe('Letters (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let employeeId: string;
  let employeeToken: string;

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
      organizationName: 'Letters E2E Org',
      name: 'Founder',
      email: 'letters-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'letters-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'HR Person', email: 'letters-e2e-hr@example.test', role: 'HR' });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'letters-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const managerCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Manager Person', email: 'letters-e2e-mgr@example.test', role: 'MANAGER' });
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'letters-e2e-mgr@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'letters-e2e-emp@example.test' });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'letters-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "employee_timeline", "audit_logs", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE and MANAGER cannot send a letter (self-download still allowed elsewhere, sending is HR/ADMIN only)', async () => {
    await request(app.getHttpServer())
      .post(`/employees/${employeeId}/letters/appointmentLetter/send`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/employees/${employeeId}/letters/appointmentLetter/send`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
  });

  it('ADMIN sends the Appointment Letter — logs an audit entry and a timeline event', async () => {
    const res = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/letters/appointmentLetter/send`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((res.body as SendResultBody).message).toContain('Appointment Letter');
    expect((res.body as SendResultBody).message).toContain(
      'letters-e2e-emp@example.test',
    );

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LETTER_EMAILED', targetId: employeeId },
    });
    expect(audit).not.toBeNull();

    const timeline = await prisma.employeeTimeline.findFirst({
      where: { employeeId, eventKey: 'LETTER_EMAILED' },
    });
    expect(timeline).not.toBeNull();
  });

  it('HR can also send a letter', async () => {
    await request(app.getHttpServer())
      .post(`/employees/${employeeId}/letters/appointmentLetter/send`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(201);
  });

  it('GET :key/content returns the rendered title/body as plain text, with no document number side effect', async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/appointmentLetter/content`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as { title: string; body: string };
    expect(body.title).toContain('Appointment');
    expect(body.body).toContain('Plain Employee');

    // EMPLOYEE/MANAGER can't reach it either — same HR/ADMIN-only gate as
    // :key/send, not the self-or-role gate the plain :key download uses.
    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/appointmentLetter/content`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('sending with an edited title/body uses that text verbatim and is flagged as edited in the audit log', async () => {
    const res = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/letters/appointmentLetter/send`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'A Custom Edited Title',
        body: 'A hand-edited paragraph for this one send only.',
      })
      .expect(201);
    expect((res.body as SendResultBody).message).toContain(
      'Appointment Letter',
    );

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LETTER_EMAILED', targetId: employeeId },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit?.details as { edited?: boolean } | null)?.edited).toBe(true);

    // The stored template itself is untouched by an edited send.
    const contentAfter = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/appointmentLetter/content`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((contentAfter.body as { title: string }).title).not.toBe(
      'A Custom Edited Title',
    );
  });

  it('sending unedited (no title/body in the request) is flagged as not edited', async () => {
    await request(app.getHttpServer())
      .post(`/employees/${employeeId}/letters/appointmentLetter/send`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LETTER_EMAILED', targetId: employeeId },
      orderBy: { createdAt: 'desc' },
    });
    const edited = (audit?.details as { edited?: boolean } | null)?.edited;
    expect(edited).toBe(false);
  });

  it('404s sending a letter for a non-existent employee', async () => {
    await request(app.getHttpServer())
      .post('/employees/00000000-0000-0000-0000-000000000000/letters/appointmentLetter/send')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it("400s sending an unknown letter key (no active template)", async () => {
    await request(app.getHttpServer())
      .post(`/employees/${employeeId}/letters/notARealKey/send`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('BASIC-profile new letter types (Confirmation, Probation Extension, Promotion, Transfer, Warning) generate with no prerequisite', async () => {
    for (const key of [
      'confirmationLetter',
      'probationExtensionLetter',
      'promotionLetter',
      'transferLetter',
      'warningLetter',
    ]) {
      await request(app.getHttpServer())
        .get(`/employees/${employeeId}/letters/${key}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    }
  });

  it('NDA and Non-Compete Agreement generate with no prerequisite', async () => {
    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/nda`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/nonCompeteAgreement`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('EXIT-profile new letter types (Resignation Acceptance, Termination) need an offboarding case, same as Relieving Letter', async () => {
    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/resignationAcceptance`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/terminationLetter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);

    await request(app.getHttpServer())
      .post('/offboarding')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        lastWorkingDay: '2026-12-31',
        reason: 'Better opportunity',
      })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/resignationAcceptance`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/terminationLetter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('second-batch BASIC letter types generate with no prerequisite', async () => {
    for (const key of [
      'nonSolicitationAgreement',
      'letterOfIntent',
      'backgroundVerificationConsent',
      'showCauseNotice',
      'suspensionLetter',
      'employmentVerificationLetter',
    ]) {
      await request(app.getHttpServer())
        .get(`/employees/${employeeId}/letters/${key}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    }
  });

  it('Retirement Letter and Internship Certificate need an offboarding case, same as Relieving Letter (offboarding already initiated by the earlier test)', async () => {
    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/retirementLetter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/internshipCertificate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});
