// One-time sync for the EmployeeIdService fix (see document-numbering.ts /
// employee-id.service.ts) — any organization that already has real
// employees was accumulating them through the old, disconnected
// employeeIdPrefix/employeeIdCounter mechanism, while
// documentNumbering.employeeId.counter sat untouched at its seed value
// (0) the whole time, since nothing ever wrote to it. Without this sync,
// the first employee created after the fix ships would get a number that
// looks like #1 again (not a duplicate — @@unique([organizationId,
// employeeId]) still protects against an actual collision if the format
// happens to coincide with an old one — but confusingly non-sequential).
//
// This sets documentNumbering.employeeId.counter to at least the
// org's current real employee count, so the next issued number continues
// on instead of restarting. Purely additive/corrective — never lowers a
// counter that's already ahead of the employee count, and touches no
// other document type (payslip numbers for already-calculated runs are
// intentionally left alone; only new calculations after this fix get a
// number, which is expected).
//
// Run once per environment: npx ts-node scripts/sync-document-numbering-counters.ts
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true, documentNumbering: true },
  });

  let updated = 0;
  for (const org of orgs) {
    const employeeCount = await prisma.user.count({
      where: { organizationId: org.id },
    });
    const numbering = org.documentNumbering as Record<
      string,
      { counter?: number } | undefined
    >;
    const entry = numbering.employeeId;
    if (!entry) {
      console.log(`Skipped ${org.name} (${org.id}) — no employeeId entry.`);
      continue;
    }
    const currentCounter = entry.counter ?? 0;
    if (currentCounter >= employeeCount) {
      console.log(
        `Skipped ${org.name} (${org.id}) — counter (${currentCounter}) already >= employee count (${employeeCount}).`,
      );
      continue;
    }

    await prisma.organization.update({
      where: { id: org.id },
      data: {
        documentNumbering: {
          ...numbering,
          employeeId: { ...entry, counter: employeeCount },
        } as Prisma.InputJsonValue,
      },
    });
    updated += 1;
    console.log(
      `Updated ${org.name} (${org.id}) — counter ${currentCounter} -> ${employeeCount}.`,
    );
  }

  console.log(`Done — ${updated}/${orgs.length} organization(s) updated.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
