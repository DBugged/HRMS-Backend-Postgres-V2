import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrivacyAuditService } from '../src/privacy/privacy-audit.service';

// Overlapping sensitive actions (two quick exports) must each leave an audit row: a write conflict on the hash chain is
// retried, not swallowed.
describe('Privacy audit under concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let audit: PrivacyAuditService;
  let organizationId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    audit = app.get(PrivacyAuditService);
    await request(app.getHttpServer()).post('/auth/register').send({
      organizationName: 'Audit Concurrency Org',
      name: 'Founder',
      email: 'audit-conc@example.test',
      password: 'TestPass123!',
    });
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'audit-conc@example.test' },
      })
    ).organizationId;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('writes every row of 25 simultaneous log calls, with an unbroken hash chain', async () => {
    const before = await prisma.privacyAuditLog.count({
      where: { organizationId },
    });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        audit.log({
          organizationId,
          actorRole: 'ADMIN',
          action: 'REPORT_EXPORTED',
          category: 'EXPORT',
          meta: { n: i },
        }),
      ),
    );
    const rows = await prisma.privacyAuditLog.findMany({
      where: { organizationId },
      orderBy: { seq: 'asc' },
    });
    expect(rows.length - before).toBe(25);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].prevHash).toBe(rows[i - 1].hash);
    }
  });
});
