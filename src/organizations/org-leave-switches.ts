// Purpose: Company-wide leave switches (Organization Settings → Policies) that sit ABOVE each leave
//   type's own Carry Forward / Encashment / Negative Balance settings.
// Important: Stored in Organization.policies; anything other than an explicit `false` means allowed,
//   so orgs that predate these switches behave exactly as before. A switch being off never changes
//   a leave type's own values — turning it back on restores them as they were.
import type { Prisma } from '@prisma/client';

export interface OrgLeaveSwitches {
  allowCarryForward: boolean;
  allowLeaveEncashment: boolean;
  allowNegativeLeaveBalance: boolean;
}

export function readOrgLeaveSwitches(policies: unknown): OrgLeaveSwitches {
  const p = (policies ?? {}) as Partial<
    Record<keyof OrgLeaveSwitches, unknown>
  >;
  return {
    allowCarryForward: p.allowCarryForward !== false,
    allowLeaveEncashment: p.allowLeaveEncashment !== false,
    allowNegativeLeaveBalance: p.allowNegativeLeaveBalance !== false,
  };
}

export async function getOrgLeaveSwitches(
  prisma: Pick<Prisma.TransactionClient, 'organization'>,
  organizationId: string,
): Promise<OrgLeaveSwitches> {
  const org = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { policies: true },
  });
  return readOrgLeaveSwitches(org?.policies);
}
