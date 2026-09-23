// Purpose: make a statutory salary component's displayed Active state follow its Statutory Compliance switch
// (PF/ESI/PT/LWF/NPS/Gratuity/Bonus), so the Salary Components page never disagrees with Statutory Compliance.
// Important: this is DISPLAY-ONLY. The stored isActive stays true for these components because payroll gates
// each statutory module per pay-period date via the effective statutory version (statutory-overlay) — flipping
// the stored flag by "today's" state would wrongly drop them from back-dated payroll runs. Employee and
// employer components share a module key (PF_EMPLOYEE / PF_EMPLOYER / EDLI / EPF admin all carry PF).
import { Prisma, StatutoryKey, StatutoryModule } from '@prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { localDateStr } from '../employee-salary-components/salary-structure-math';

async function resolveOrgTimezone(
  db: ExtendedPrismaClient | Prisma.TransactionClient,
  organizationId: string,
): Promise<string> {
  const org = await db.organization.findFirst({
    where: { id: organizationId },
    select: { timezone: true },
  });
  return org?.timezone ?? 'Asia/Kolkata';
}

// StatutoryKey values that have a matching StatutoryModule switch.
export const STATUTORY_GATED_KEYS: StatutoryKey[] = [
  StatutoryKey.PF,
  StatutoryKey.ESI,
  StatutoryKey.PT,
  StatutoryKey.LWF,
  StatutoryKey.NPS,
  StatutoryKey.GRATUITY,
  StatutoryKey.BONUS,
];

/** Enabled/disabled per statutory key as of today; keys with no version yet are omitted. */
export async function statutoryEnabledToday(
  db: ExtendedPrismaClient | Prisma.TransactionClient,
  organizationId: string,
  todayParam?: string,
): Promise<Map<StatutoryKey, boolean>> {
  const today =
    todayParam ?? localDateStr(await resolveOrgTimezone(db, organizationId));
  const versions = await db.statutoryConfigVersion.findMany({
    where: {
      organizationId,
      module: { in: STATUTORY_GATED_KEYS as unknown as StatutoryModule[] },
      effectiveFrom: { lte: today },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
    },
    orderBy: { effectiveFrom: 'asc' },
    select: { module: true, isEnabled: true },
  });
  // Ascending order so a later version overwrites an earlier one for the same module.
  const enabled = new Map<StatutoryKey, boolean>();
  for (const v of versions)
    enabled.set(v.module as unknown as StatutoryKey, v.isEnabled);
  return enabled;
}
