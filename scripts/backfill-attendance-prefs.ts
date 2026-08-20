// One-time backfill for the attendancePayrollPrefs/orgPayrollAttendancePrefs
// fix (see OrganizationSettingsService.updateSection) — every org created
// before that fix has attendancePayrollPrefs frozen at the schema's
// hardcoded default, disconnected from whatever they've actually
// configured via Setup Wizard step 8. This derives it fresh from each
// org's current orgPayrollAttendancePrefs, matching exactly what a new
// 'attendancePayroll' section write does going forward. Purely additive —
// only ever overwrites attendancePayrollPrefs, never deletes anything.
//
// Run once per environment: npx ts-node scripts/backfill-attendance-prefs.ts
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const ATTENDANCE_PREFS_KEYS = [
  'defaultShiftStartTime',
  'defaultShiftEndTime',
  'defaultLateInThresholdMinutes',
  'defaultEarlyOutThresholdMinutes',
  'defaultMinHoursForPresent',
  'defaultMinHoursForHalfDay',
  'weekendDays',
] as const;

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true, orgPayrollAttendancePrefs: true },
  });

  let updated = 0;
  for (const org of orgs) {
    const wizardPrefs = org.orgPayrollAttendancePrefs as Record<
      string,
      unknown
    >;
    const derived = ATTENDANCE_PREFS_KEYS.reduce(
      (acc, key) => {
        if (key in wizardPrefs) acc[key] = wizardPrefs[key];
        return acc;
      },
      {} as Record<string, unknown>,
    );
    await prisma.organization.update({
      where: { id: org.id },
      data: { attendancePayrollPrefs: derived as Prisma.InputJsonValue },
    });
    updated += 1;
    console.log(`Updated ${org.name} (${org.id})`);
  }

  console.log(`Done — ${updated}/${orgs.length} organization(s) updated.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
