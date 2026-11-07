import { AttendanceStatus, WfhApprovalStatus, WorkArrangement } from '@prisma/client';
import { showsAsWfh } from './wfh-cell';

const wfh = { workArrangement: WorkArrangement.WFH, workArrangementStatus: WfhApprovalStatus.APPROVED };

describe('showsAsWfh', () => {
  it('shows WFH for a Present day worked from home', () => {
    expect(showsAsWfh({ ...wfh, status: AttendanceStatus.PRESENT })).toBe(true);
  });
  it('keeps the real status when the WFH day came to Absent, Half Day or Incomplete', () => {
    expect(showsAsWfh({ ...wfh, status: AttendanceStatus.ABSENT })).toBe(false); // 3h 7m worked
    expect(showsAsWfh({ ...wfh, status: AttendanceStatus.HALF_DAY })).toBe(false);
    expect(showsAsWfh({ ...wfh, status: AttendanceStatus.INCOMPLETE })).toBe(false);
  });
  it('does not treat a turned-down WFH request as a WFH day', () => {
    expect(showsAsWfh({ status: AttendanceStatus.PRESENT, workArrangement: WorkArrangement.WFH, workArrangementStatus: WfhApprovalStatus.REJECTED })).toBe(false);
  });
  it('is false for an office day', () => {
    expect(showsAsWfh({ status: AttendanceStatus.PRESENT, workArrangement: WorkArrangement.OFFICE })).toBe(false);
  });
});
