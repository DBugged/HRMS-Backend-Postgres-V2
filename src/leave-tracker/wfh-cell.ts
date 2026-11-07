// Purpose: when an Attendance Tracker cell reads "WFH".
// Important: WFH is a present day worked from home (as in the attendance calendar), so a day only shows as WFH when its status
//   is Present. A WFH day that came to Absent (too few hours), Half Day or Incomplete keeps that status, and a turned-down
//   WFH request is not a WFH day at all.
import { AttendanceStatus, WfhApprovalStatus, WorkArrangement } from '@prisma/client';

export function showsAsWfh(row: {
  status: AttendanceStatus;
  workArrangement: WorkArrangement;
  workArrangementStatus?: WfhApprovalStatus | null;
}): boolean {
  return (
    row.status === AttendanceStatus.PRESENT &&
    row.workArrangement === WorkArrangement.WFH &&
    row.workArrangementStatus !== WfhApprovalStatus.REJECTED
  );
}
