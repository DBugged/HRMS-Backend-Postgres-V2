// Purpose: When an employee may cancel their own leave, and when they must ask instead.
// Important: a pending or returned leave can always be cancelled by its owner (nothing has happened yet). An approved
//   leave can be cancelled by the owner only until the leave starts - plus the company's grace window
//   (Organization Settings > Policies > "Employee can cancel approved leave for N days after it starts", default 0).
//   After that, while the leave is still running (up to its last day), the employee sends a cancellation request that a
//   manager, HR or Admin decides; a leave already taken in full is not cancelled by the employee at all. The company can
//   also limit the direct cancel to N days after approval (Policies > leaveCancelAfterApprovalDays). Only an Admin cancels
//   their OWN leave at any time; HR follows the same rules as everyone else for their own leave. The server enforces this; clients only use the flags to show the right button.
import { LeaveStatus } from '@prisma/client';

export const MAX_CANCEL_WINDOW_DAYS = 90;
export const MAX_CANCEL_AFTER_APPROVAL_DAYS = 365;

/**
 * Days after approval during which the owner may still cancel an approved leave directly (0 = only on the day it was approved).
 * null = no limit from approval (only the start-date rule applies). Anything unset or invalid is null.
 */
export function leaveCancelAfterApprovalDaysOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_CANCEL_AFTER_APPROVAL_DAYS ? n : null;
}

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
  endDate: string;
  cancelRequestedAt?: Date | null;
  // The day (in the company's time zone) an approver approved it; null when unknown (e.g. a leave recorded by HR).
  approvedOn?: string | null;
}

/** The leave is over: its last day has passed (it was taken in full), so the employee no longer asks to cancel it. */
export function leaveTaken(leave: CancelSubject, today: string): boolean {
  return today > leave.endDate;
}

/** Whether the owner may cancel this leave directly today. */
export function ownerCanCancel(
  leave: CancelSubject,
  today: string,
  windowDays: number,
  afterApprovalDays: number | null = null,
): boolean {
  if (leave.status === LeaveStatus.PENDING || leave.status === LeaveStatus.RETURNED) {
    return true;
  }
  if (leave.status !== LeaveStatus.APPROVED) return false;
  // Only within the company's "days after approval" window, when it has set one.
  if (afterApprovalDays !== null && leave.approvedOn && today > addDays(leave.approvedOn, afterApprovalDays)) return false;
  // Earlier than the start date plus the grace days.
  return today < addDays(leave.startDate, windowDays);
}

/**
 * Whether an Admin / HR may cancel someone else's leave from the leave list: it is still waiting or approved and it has not
 * started (today or later), so nothing has been taken yet. The server still lets them cancel any time through the API.
 */
export function adminCanCancelOthers(leave: CancelSubject, today: string): boolean {
  const cancellable =
    leave.status === LeaveStatus.PENDING ||
    leave.status === LeaveStatus.RETURNED ||
    leave.status === LeaveStatus.APPROVED;
  return cancellable && leave.startDate >= today;
}

/** What the owner is offered on a leave: cancel it now, or ask for it to be cancelled. */
export function ownerCancelOptions(
  leave: CancelSubject,
  today: string,
  windowDays: number,
  // An Admin / HR owner cancels their own leave directly at any time (nobody above them has to agree), so they are
  // never sent through a cancellation request that would sit pending.
  canAlwaysCancel = false,
  afterApprovalDays: number | null = null,
): { canCancel: boolean; canRequestCancel: boolean } {
  const cancellable =
    leave.status === LeaveStatus.PENDING ||
    leave.status === LeaveStatus.RETURNED ||
    leave.status === LeaveStatus.APPROVED;
  const canCancel = canAlwaysCancel ? cancellable : ownerCanCancel(leave, today, windowDays, afterApprovalDays);
  return {
    canCancel,
    canRequestCancel:
      !canCancel &&
      leave.status === LeaveStatus.APPROVED &&
      !leave.cancelRequestedAt &&
      !leaveTaken(leave, today),
  };
}
