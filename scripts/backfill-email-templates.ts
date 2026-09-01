// One-time backfill for the newly-added occasion-based email templates (see
// src/email-templates/email-template-defaults.ts) — every org created before these were added only got
// BIRTHDAY/WORK_ANNIVERSARY via AuthService.register()'s seedDefaults() call, which never runs again for an
// already-registered org. This creates any of the newer occasions that are missing (idempotent — skips an
// org/occasionKey pair that already exists), so the app-wide notification emails (leave decisions, payslip
// issued, loan sanctioned, etc.) are admin-editable for pre-existing orgs too, not just new ones.
//
// Run once per environment: npx ts-node scripts/backfill-email-templates.ts
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { EMAIL_TEMPLATE_DEFAULTS } from '../src/email-templates/email-template-defaults';

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });

  let created = 0;
  for (const org of orgs) {
    const existingKeys = new Set(
      (
        await prisma.emailTemplate.findMany({
          where: { organizationId: org.id },
          select: { occasionKey: true },
        })
      ).map((t) => t.occasionKey),
    );
    for (const def of EMAIL_TEMPLATE_DEFAULTS) {
      if (existingKeys.has(def.occasionKey)) continue;
      await prisma.emailTemplate.create({
        data: {
          organizationId: org.id,
          occasionKey: def.occasionKey,
          name: def.name,
          subject: def.subject,
          bodyHtml: def.bodyHtml,
          ccAllActive: def.ccAllActive,
          isCustom: false,
        },
      });
      created += 1;
      console.log(`  + ${def.occasionKey} for ${org.name} (${org.id})`);
    }
  }

  console.log(`Done — ${created} email template(s) created across ${orgs.length} organization(s).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
