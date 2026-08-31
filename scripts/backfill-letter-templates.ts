// One-time backfill for the LetterTemplate feature (see src/letter-templates/) — every org created before
// this feature only gets the 7 built-in letter templates via AuthService.register()'s seedDefaults() call,
// which never runs for an already-registered org. This creates any of the 7 that are missing (idempotent —
// skips an org/key pair that already exists), so GET /employees/:id/letters/:key works for pre-existing
// orgs without an admin having to recreate each one by hand.
//
// Run once per environment: npx ts-node scripts/backfill-letter-templates.ts
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { LETTER_TEMPLATE_DEFAULTS } from '../src/letter-templates/letter-template-defaults';

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });

  let created = 0;
  for (const org of orgs) {
    const existingKeys = new Set(
      (
        await prisma.letterTemplate.findMany({
          where: { organizationId: org.id },
          select: { key: true },
        })
      ).map((t) => t.key),
    );
    for (const def of LETTER_TEMPLATE_DEFAULTS) {
      if (existingKeys.has(def.key)) continue;
      await prisma.letterTemplate.create({
        data: {
          organizationId: org.id,
          key: def.key,
          name: def.name,
          title: def.title,
          addressedToEmployee: def.addressedToEmployee,
          dataProfile: def.dataProfile,
          bodyText: def.bodyText,
          isCustom: false,
        },
      });
      created += 1;
      console.log(`  + ${def.key} for ${org.name} (${org.id})`);
    }
  }

  console.log(`Done — ${created} letter template(s) created across ${orgs.length} organization(s).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
