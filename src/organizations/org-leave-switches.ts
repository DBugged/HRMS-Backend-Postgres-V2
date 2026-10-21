// Purpose: Company-wide leave switches (Organization Settings → Policies) that sit ABOVE each leave
//   type's own Carry Forward / Encashment / Negative Balance settings.
// Important: Stored in Organization.policies. Carry Forward and Encashment: anything other than an explicit `false`
//   means allowed, so orgs that predate these switches behave exactly as before. Negative Leave Balance is the other
//   way round - it is OFF unless explicitly `true`, because before this switch existed leave could never go negative.
//   A switch being off never changes a leave type's own values — turning it back on restores them as they were.
import type { Prisma } from '@prisma/client';

// What happens to leave taken beyond the balance while Allow Negative Leave Balance is on (the same three choices as
// Zoho): MARK_AS_LOP - the days beyond the balance are applied as Loss of Pay and deducted from pay; UNLIMITED - the
// balance may go below zero without limit; UP_TO_YEAR_END - it may go below zero only by what the leave type will still
// credit before the leave year ends (periodic accrual types), and a negative balance is cleared at year end.
export const NEGATIVE_BALANCE_MODES = [
  'MARK_AS_LOP',
  'UNLIMITED',
  'UP_TO_YEAR_END',
] as const;
export type NegativeBalanceMode = (typeof NEGATIVE_BALANCE_MODES)[number];

export interface OrgLeaveSwitches {
  allowCarryForward: boolean;
  allowLeaveEncashment: boolean;
  allowNegativeLeaveBalance: boolean;
  negativeLeaveBalanceMode: NegativeBalanceMode;
}

export function readOrgLeaveSwitches(policies: unknown): OrgLeaveSwitches {
  const p = (policies ?? {}) as Partial<
    Record<keyof OrgLeaveSwitches, unknown>
  >;
  return {
    allowCarryForward: p.allowCarryForward !== false,
    allowLeaveEncashment: p.allowLeaveEncashment !== false,
    allowNegativeLeaveBalance: p.allowNegativeLeaveBalance === true,
    negativeLeaveBalanceMode: (
      NEGATIVE_BALANCE_MODES as readonly unknown[]
    ).includes(p.negativeLeaveBalanceMode)
      ? (p.negativeLeaveBalanceMode as NegativeBalanceMode)
      : 'MARK_AS_LOP',
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
