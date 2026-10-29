// Purpose: the DPDP clock on a breach incident - the detailed report to the Data Protection Board is due 72 hours after the
//   breach was detected.
// Responsibilities: works out when the report is due and whether it is still owed, due soon or overdue, for the register and
//   for the reminder sweep.
// Important: pure, no database. The Board can allow longer on request; that is recorded in the incident's notes, not here.
import { BreachNotificationStatus, BreachStatus } from '@prisma/client';

export const BOARD_REPORT_HOURS = 72;
// The "due soon" reminder goes this long before the deadline.
export const DUE_SOON_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

export interface BreachClockInput {
  detectedAt: Date;
  status: BreachStatus;
  notificationStatus: BreachNotificationStatus;
  boardReportedAt: Date | null;
}

export function boardReportDueAt(detectedAt: Date): Date {
  return new Date(detectedAt.getTime() + BOARD_REPORT_HOURS * HOUR_MS);
}

// Still owed: the incident is open, nobody has decided a report is not required, and none has been sent yet.
export function boardReportOwed(b: BreachClockInput): boolean {
  return (
    b.status === BreachStatus.OPEN &&
    b.notificationStatus !== BreachNotificationStatus.NOT_REQUIRED &&
    b.boardReportedAt === null
  );
}

export type BoardReportState =
  'NOT_REQUIRED' | 'REPORTED' | 'DUE' | 'DUE_SOON' | 'OVERDUE' | 'CLOSED';

export function boardReportState(
  b: BreachClockInput,
  now: Date = new Date(),
): BoardReportState {
  if (b.boardReportedAt) return 'REPORTED';
  if (b.notificationStatus === BreachNotificationStatus.NOT_REQUIRED)
    return 'NOT_REQUIRED';
  if (b.status === BreachStatus.CLOSED) return 'CLOSED';
  const left = boardReportDueAt(b.detectedAt).getTime() - now.getTime();
  if (left < 0) return 'OVERDUE';
  if (left <= DUE_SOON_HOURS * HOUR_MS) return 'DUE_SOON';
  return 'DUE';
}

// The register row as the API returns it: the stored incident plus the worked-out deadline.
export function withBoardDeadline<T extends BreachClockInput>(
  b: T,
  now: Date = new Date(),
) {
  return {
    ...b,
    boardReportDueAt: boardReportDueAt(b.detectedAt),
    boardReportState: boardReportState(b, now),
  };
}
