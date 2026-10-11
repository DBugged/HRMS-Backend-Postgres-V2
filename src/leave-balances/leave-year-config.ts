// Purpose: Reads an organisation's leave-year setting. See leave-year.ts for what the setting means.
import type { Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CALENDAR_LEAVE_YEAR, LeaveYearConfig } from './leave-year';

export async function getLeaveYearConfig(
  db: Pick<Prisma.TransactionClient, 'organization'> | ExtendedPrismaClient,
  organizationId: string,
): Promise<LeaveYearConfig> {
  const org = await (
    db as Pick<Prisma.TransactionClient, 'organization'>
  ).organization.findFirst({
    where: { id: organizationId },
    select: { leaveYearStartMonth: true, leaveYearAnchorYear: true },
  });
  if (!org) return CALENDAR_LEAVE_YEAR;
  return {
    startMonth: org.leaveYearStartMonth,
    anchorYear: org.leaveYearAnchorYear,
  };
}
