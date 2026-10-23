// Purpose: the pure rule for "may this company add another employee?" against the hard limit a Super Admin set on its subscription.
// Important: no limit (null) means always allowed. The limit counts ACTIVE employees; deactivating one frees a place.
export interface RoomVerdict {
  allowed: boolean;
  max: number | null;
  used: number;
}

export function employeeRoom(max: number | null | undefined, used: number, adding = 1): RoomVerdict {
  if (max == null) return { allowed: true, max: null, used };
  return { allowed: used + adding <= max, max, used };
}

export const employeeLimitMessage = (v: RoomVerdict): string =>
  `Your plan allows up to ${v.max} employees and you already have ${v.used}. Please contact support to move to a bigger plan.`;
