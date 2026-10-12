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

const PASSWORD = 'TestPass123!';

// Fixes from the QA sheet (reason required, input limits, locked fields, token after password change, letters,
// privacy, reports, setup).
describe('QA sheet fixes (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let hrToken: string;
  let organizationId: string;
  let employeeId: string;
  let employeeEmail: string;
  let employeePassword: string;
  let employeeToken: string;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (u: string) => http().get(u).set('Authorization', `Bearer ${token}`),
    post: (u: string) => http().post(u).set('Authorization', `Bearer ${token}`),
    put: (u: string) => http().put(u).set('Authorization', `Bearer ${token}`),
    patch: (u: string) =>
      http().patch(u).set('Authorization', `Bearer ${token}`),
  });
  const admin = () => as(adminToken);

  const login = async (email: string, password: string) =>
    (
      (await http().post('/auth/login').send({ email, password }))
        .body as AuthBody
    ).accessToken;

  const mkEmployee = async (name: string, email: string, role?: string) => {
    const res = await admin()
      .post('/employees')
      .send({
        name,
        email,
        joiningDate: '2025-01-01',
        ...(role ? { role } : {}),
      });
    expect(res.status).toBe(201);
    const body = res.body as EmployeeCreateBody;
    return {
      id: body.employee.id,
      email,
      password: body.generatedPassword,
      token: await login(email, body.generatedPassword),
    };
  };

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
      organizationName: 'QA Fixes Org',
      name: 'Founder',
      email: 'qa-admin@example.test',
      password: PASSWORD,
    });
    adminToken = await login('qa-admin@example.test', PASSWORD);
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'qa-admin@example.test' },
      })
    ).organizationId;
    const hr = await mkEmployee('Hari Hr', 'qa-hr@example.test', 'HR');
    hrToken = hr.token;
    const emp = await mkEmployee('Esha Employee', 'qa-emp@example.test');
    employeeId = emp.id;
    employeeEmail = emp.email;
    employeePassword = emp.password;
    employeeToken = emp.token;
  });

  afterAll(async () => {
    // Background work started by the last requests (attendance recalculation after a punch) can still be writing:
    // wait for it to settle, and retry if the clean-up collides with it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await prisma.$executeRawUnsafe(
          'TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE',
        );
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
    await app.close();
  });

  describe('a reason is required to reject', () => {
    let docId: string;
    beforeAll(async () => {
      const res = await as(employeeToken)
        .post(`/employees/${employeeId}/documents`)
        .send({
          docType: 'PAN Card',
          fileName: 'pan.pdf',
          fileUrl: 'x/pan.pdf',
        });
      docId = (res.body as { id: string }).id;
      expect(docId).toBeTruthy();
    });

    it('document: no reason, or a blank one, is refused', async () => {
      for (const body of [
        { status: 'REJECTED' },
        { status: 'REJECTED', reason: '   ' },
      ]) {
        const res = await admin()
          .patch(`/employees/${employeeId}/documents/${docId}/review`)
          .send(body);
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toMatch(/reason is required/i);
      }
    });

    it('document: with a reason it is rejected and the reason is kept; approving needs none', async () => {
      const rejected = await admin()
        .patch(`/employees/${employeeId}/documents/${docId}/review`)
        .send({ status: 'REJECTED', reason: '  Photo is blurry ' });
      expect(rejected.status).toBe(200);
      expect((rejected.body as { reviewReason: string }).reviewReason).toBe(
        'Photo is blurry',
      );
      const approved = await admin()
        .patch(`/employees/${employeeId}/documents/${docId}/review`)
        .send({ status: 'APPROVED' });
      expect(approved.status).toBe(200);
    });

    it('performance rating: reject needs a reason', async () => {
      // a manager's rating of their report waits as SUBMITTED for HR/Admin to decide
      const manager = await mkEmployee(
        'Mona Manager',
        'qa-mgr@example.test',
        'MANAGER',
      );
      await admin()
        .patch(`/employees/${employeeId}`)
        .send({ reportingManagerId: manager.id })
        .expect(200);
      await as(manager.token)
        .post('/performance-ratings')
        .send({ employeeId, financialYear: '2026-27', rating: 4 })
        .expect(201);
      const rating = await prisma.performanceRating.findFirstOrThrow({
        where: { employeeId, financialYear: '2026-27' },
      });
      expect(rating.status).toBe('SUBMITTED');
      const none = await admin()
        .patch(`/performance-ratings/${rating.id}/reject`)
        .send({});
      expect(none.status).toBe(400);
      const blank = await admin()
        .patch(`/performance-ratings/${rating.id}/reject`)
        .send({ reason: '  ' });
      expect(blank.status).toBe(400);
      const ok = await admin()
        .patch(`/performance-ratings/${rating.id}/reject`)
        .send({ reason: 'Rating does not match the review notes' });
      expect(ok.status).toBe(200);
    });
  });

  describe('employee input limits', () => {
    it('document type and file name have length limits', async () => {
      const longType = await as(employeeToken)
        .post(`/employees/${employeeId}/documents`)
        .send({
          docType: 'T'.repeat(501),
          fileName: 'a.pdf',
          fileUrl: 'x/a.pdf',
        });
      expect(longType.status).toBe(400);
      const longName = await as(employeeToken)
        .post(`/employees/${employeeId}/documents`)
        .send({
          docType: 'Other',
          fileName: 'n'.repeat(1001),
          fileUrl: 'x/a.pdf',
        });
      expect(longName.status).toBe(400);
    });

    it('personal data: unknown keys and over-long text are refused, known fields still save', async () => {
      const unknown = await as(employeeToken)
        .patch(`/employees/${employeeId}/personal-data`)
        .send({ personalData: { hackerField: 'x' } });
      expect(unknown.status).toBe(400);
      expect(JSON.stringify(unknown.body)).toMatch(
        /Unknown personal data field/,
      );
      const long = await as(employeeToken)
        .patch(`/employees/${employeeId}/personal-data`)
        .send({ personalData: { fatherName: 'a'.repeat(5000) } });
      expect(long.status).toBe(400);
      const ok = await as(employeeToken)
        .patch(`/employees/${employeeId}/personal-data`)
        .send({
          personalData: { fatherName: 'Ramesh Kumar', bloodGroup: 'B+' },
        });
      expect(ok.status).toBe(200);
      // a key already stored is always allowed back (a form re-sending an older record)
      await prisma.user.update({
        where: { id: employeeId },
        data: {
          personalData: {
            ...((
              await prisma.user.findFirstOrThrow({ where: { id: employeeId } })
            ).personalData as object),
            legacyKey: 'old',
          },
        },
      });
      const again = await as(employeeToken)
        .patch(`/employees/${employeeId}/personal-data`)
        .send({
          personalData: { legacyKey: 'old', fatherName: 'Ramesh Kumar' },
        });
      expect(again.status).toBe(200);
    });

    it('locked fields: a real change answers 403 with the field names; re-sending the same value is fine', async () => {
      const changed = await as(employeeToken)
        .patch(`/employees/${employeeId}`)
        .send({ designation: 'Chief Executive', role: 'ADMIN' });
      expect(changed.status).toBe(403);
      expect(JSON.stringify(changed.body)).toMatch(/designation/);
      const current = await prisma.user.findFirstOrThrow({
        where: { id: employeeId },
      });
      const same = await as(employeeToken)
        .patch(`/employees/${employeeId}`)
        .send({ designation: current.designation, role: current.role });
      expect(same.status).toBe(200);
    });

    it('HR cannot change a designation (Admin only) and is told so', async () => {
      const res = await as(hrToken)
        .patch(`/employees/${employeeId}`)
        .send({ designation: 'Senior Engineer' });
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(
        /Only an Admin can change Designation/,
      );
    });
  });

  describe('password change ends older sessions', () => {
    it('the old access token stops working at once; the fresh one from the change works', async () => {
      const before = await as(employeeToken).get('/auth/me');
      expect(before.status).toBe(200);
      // tokens carry whole seconds: make sure the change lands in a later second
      await new Promise((r) => setTimeout(r, 1100));
      const changed = await as(employeeToken)
        .post('/auth/change-password')
        .send({
          currentPassword: employeePassword,
          newPassword: 'NewPass456!x',
        });
      expect(changed.status).toBe(201);
      const fresh = (changed.body as AuthBody).accessToken;
      const old = await as(employeeToken).get('/auth/me');
      expect(old.status).toBe(401);
      const now = await as(fresh).get('/auth/me');
      expect(now.status).toBe(200);
      employeeToken = fresh;
      employeePassword = 'NewPass456!x';
      void employeeEmail;
    });
  });

  describe('letters', () => {
    it('an edited letter fills {{placeholders}} and never keeps stray HTML', async () => {
      const put = await admin()
        .put(`/employees/${employeeId}/letters/confirmationLetter/content`)
        .send({
          title: '<b>Confirmation</b> for {{employeeName}}',
          body: '<p>Dear {{firstName}},</p>\n<span style="x">Terms &amp; Conditions</span> <b>apply</b><br>Regards',
        });
      expect(put.status).toBe(200);
      const content = await admin().get(
        `/employees/${employeeId}/letters/confirmationLetter/content`,
      );
      expect(content.status).toBe(200);
      const body = content.body as { title: string; body: string };
      expect(body.title).toBe('Confirmation for Esha Employee');
      expect(body.body).toContain('Dear Esha,');
      expect(body.body).toContain('Terms & Conditions');
      expect(body.body).toContain('<b>apply</b>');
      expect(body.body).not.toMatch(/<span|<p>|&amp;|\{\{/);
    });

    it('the downloaded file is named "<Employee ID>-<Letter name>.pdf"', async () => {
      const res = await admin().get(
        `/employees/${employeeId}/letters/appointmentLetter`,
      );
      expect(res.status).toBe(200);
      const header = String(res.headers['content-disposition']);
      const code = (
        await prisma.user.findFirstOrThrow({ where: { id: employeeId } })
      ).employeeId;
      expect(header).toContain(`filename="${code}-Appointment Letter.pdf"`);
    });
  });

  describe('data privacy', () => {
    it('privacy notice text is stored as plain text: scripts removed, entities decoded', async () => {
      const res = await admin().post('/privacy/notices').send({
        title: '<i>Notice</i>',
        body: 'Hello <script>alert(1)</script>there &amp; welcome <b>all</b>',
        publish: false,
      });
      expect(res.status).toBe(201);
      const notice = res.body as { title: string; body: string };
      expect(notice.title).toBe('Notice');
      expect(notice.body).toBe('Hello there & welcome all');
    });

    it('a breach incident takes a title, and cannot be detected in the future', async () => {
      const ok = await admin()
        .post('/privacy/breaches')
        .send({
          title: 'Payroll file sent to the wrong vendor',
          detectedAt: new Date(Date.now() - 3600_000).toISOString(),
          severity: 'HIGH',
        });
      expect(ok.status).toBe(201);
      expect((ok.body as { title: string }).title).toBe(
        'Payroll file sent to the wrong vendor',
      );
      const future = await admin()
        .post('/privacy/breaches')
        .send({
          title: 'Time traveller',
          detectedAt: new Date(Date.now() + 86400_000).toISOString(),
        });
      expect(future.status).toBe(400);
    });
  });

  describe('reports', () => {
    it('statutory returns and the journal answer without month/year (they default to last month)', async () => {
      for (const url of [
        '/reports/payroll/pf-ecr/preview',
        '/reports/payroll/esic-return/preview',
        '/reports/payroll/pt-return/preview',
        '/reports/payroll/lwf-return/preview',
        '/reports/payroll/pt-return/summary',
        '/reports/payroll/statutory-bonus',
        '/reports/payroll/journal',
      ]) {
        const res = await admin().get(url);
        expect([url, res.status]).toEqual([url, 200]);
      }
    });

    it('a malformed month is still refused', async () => {
      const res = await admin().get(
        '/reports/payroll/pf-ecr/preview?month=13&year=2026',
      );
      expect(res.status).toBe(400);
    });
  });

  describe('setup: alternate weekly offs reach the default work schedule', () => {
    it('2nd/4th Saturday comes through as an alternate off, not as an always-worked day', async () => {
      const res = await admin()
        .patch('/organizations/settings/policies')
        .send({
          orgPayrollAttendancePrefs: {
            defaultShiftStartTime: '09:30',
            defaultShiftEndTime: '18:30',
            defaultMinHoursForPresent: 8,
            defaultMinHoursForHalfDay: 4,
            defaultBreakMinutes: 60,
            weekendDays: [0, 6],
            alternateWeeklyOffs: [{ day: 6, occurrences: [2, 4] }],
          },
        });
      expect(res.status).toBe(200);
      const schedule = await prisma.workSchedule.findFirstOrThrow({
        where: { organizationId },
      });
      expect(schedule.workingDays).toEqual([1, 2, 3, 4, 5]);
      expect(schedule.alternateWeeklyOffs).toEqual([
        { day: 6, occurrences: [2, 4] },
      ]);
      const org = await prisma.organization.findFirstOrThrow({
        where: { id: organizationId },
      });
      expect(
        (org.attendancePayrollPrefs as { alternateWeeklyOffs?: unknown })
          .alternateWeeklyOffs,
      ).toEqual([{ day: 6, occurrences: [2, 4] }]);
    });

    it('a malformed alternate pattern is refused', async () => {
      for (const bad of [
        [{ day: 9, occurrences: [2] }],
        [{ day: 6, occurrences: [] }],
        [{ day: 6, occurrences: [7] }],
        [
          { day: 6, occurrences: [2] },
          { day: 6, occurrences: [4] },
        ],
        'second-saturday',
      ]) {
        const res = await admin()
          .patch('/organizations/settings/policies')
          .send({
            orgPayrollAttendancePrefs: {
              defaultShiftStartTime: '09:30',
              defaultShiftEndTime: '18:30',
              defaultBreakMinutes: 60,
              alternateWeeklyOffs: bad,
            },
          });
        expect([JSON.stringify(bad), res.status]).toEqual([
          JSON.stringify(bad),
          400,
        ]);
      }
    });
  });
});
