// Purpose: When an employee may cancel their own leave, and when they must ask instead.
// Important: a pending or returned leave can always be cancelled by its owner (nothing has happened yet). An approved
//   leave can be cancelled by the owner only until the leave starts - plus the company's grace window
//   (Organization Settings > Policies > "Employee can cancel approved leave for N days after it starts", default 0).
//   After that the employee sends a cancellation request that a manager, HR or Admin decides; HR/Admin can also cancel
//   directly at any time. The server enforces this; clients only use the flags to show the right button.
import { LeaveStatus } from '@prisma/client';

export const MAX_CANCEL_WINDOW_DAYS = 90;

/** The grace window in days (0 = only before the leave starts). Anything unset or invalid means 0. */
export function leaveCancelWindowDaysOf(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_CANCEL_WINDOW_DAYS ? n : 0;
}

const addDays = (ymd: string, days: number): string => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

interface CancelSubject {
  status: LeaveStatus;
  startDate: string;
  cancelRequestedAt?: Date | null;
}

/** Whether the owner may cancel this leave directly today. */
export function ownerCanCancel(
  leave: CancelSubject,
  today: string,
  windowDays: number,
): boolean {
  if (leave.status === LeaveStatus.PENDING || leave.status === LeaveStatus.RETURNED) {
    return true;
  }
  if (leave.status !== LeaveStatus.APPROVED) return false;
  // Earlier than the start date plus the grace days.
  return today < addDays(leave.startDate, windowDays);
}

/** What the owner is offered on a leave: cancel it now, or ask for it to be cancelled. */
export function ownerCancelOptions(
  leave: CancelSubject,
  today: string,
  windowDays: number,
  // An Admin / HR owner cancels their own leave directly at any time (nobody above them has to agree), so they are
  // never sent through a cancellation request that would sit pending.
  canAlwaysCancel = false,
): { canCancel: boolean; canRequestCancel: boolean } {
  const cancellable =
    leave.status === LeaveStatus.PENDING ||
    leave.status === LeaveStatus.RETURNED ||
    leave.status === LeaveStatus.APPROVED;
  const canCancel = canAlwaysCancel ? cancellable : ownerCanCancel(leave, today, windowDays);
  return {
    canCancel,
    canRequestCancel:
      !canCancel &&
      leave.status === LeaveStatus.APPROVED &&
      !leave.cancelRequestedAt,
  };
}
