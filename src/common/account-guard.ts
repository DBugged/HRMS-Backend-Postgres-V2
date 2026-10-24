// Purpose: Protects the company's registered (founder) account and its last active Admin from being deactivated, put
// through offboarding or demoted - the Control Panel's company-admin list / password reset relies on an active Admin.
import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

export const FOUNDER_PROTECTED_MESSAGE =
  'This is the registered company account and cannot be deactivated or offboarded. Transfer ownership first by contacting support.';
export const LAST_ADMIN_MESSAGE =
  'This is the last active Admin. Make another employee an Admin before deactivating or demoting this account.';

/** Throws if `employeeId` is the founder account, or the only remaining active Admin. */
export async function assertAccountCanLeave(
  scopedPrisma: ExtendedPrismaClient,
  employeeId: string,
  organizationId: string,
): Promise<void> {
  const user = await scopedPrisma.user.findFirst({
    where: { id: employeeId, organizationId },
    select: { role: true, isFounder: true, isActive: true },
  });
  if (!user) return;
  if (user.isFounder) throw new BadRequestException(FOUNDER_PROTECTED_MESSAGE);
  if (user.role === Role.ADMIN && user.isActive) {
    const others = await scopedPrisma.user.count({
      where: { organizationId, role: Role.ADMIN, isActive: true, id: { not: employeeId } },
    });
    if (others === 0) throw new BadRequestException(LAST_ADMIN_MESSAGE);
  }
}
