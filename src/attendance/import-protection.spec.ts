import { AttendanceSource as Src, AttendanceStatus as St } from '@prisma/client';
import { importSkipReason, isHalfLeaveStamp } from './import-protection';

const day = (over: object = {}) => ({
  status: St.ABSENT,
  source: Src.SYSTEM,
  inTime: null,
  ...over,
});
const at = new Date('2026-10-05T04:00:00Z');

describe('importSkipReason', () => {
  it('leaves open a day nobody marked', () => {
    expect(importSkipReason(null, null)).toBeNull();
    for (const status of [St.ABSENT, St.WEEKLY_OFF, St.HOLIDAY]) {
      expect(importSkipReason(day({ status }), null)).toBeNull();
    }
    // An auto-written Absent has no punch behind it, whatever its source says.
    expect(importSkipReason(day({ source: Src.FACE_API }), null)).toBeNull();
    // Always present, and an earlier import.
    expect(importSkipReason(day({ status: St.PRESENT, inTime: at }), null)).toBeNull();
    expect(importSkipReason(day({ status: St.PRESENT, source: Src.EXCEL_IMPORT, inTime: at }), null)).toBeNull();
  });

  it('keeps leave, LWP included, regularizations and punches', () => {
    expect(importSkipReason(day({ status: St.ON_LEAVE }), null)).toBe('On approved leave');
    expect(importSkipReason(null, { isHalfDay: false })).toBe('On approved leave');
    expect(importSkipReason(day({ source: Src.REGULARIZED }), null)).toBe('Already regularized');
    expect(importSkipReason(day({ regularization: { status: 'pending' } }), null)).toBe('A regularization request is waiting');
    expect(importSkipReason(day({ regularization: { status: 'rejected' } }), null)).toBeNull();
    expect(importSkipReason(day({ status: St.PRESENT, source: Src.FACE_API, inTime: at }), null)).toBe('Already has a punch');
  });

  it('a half day of leave is not skipped, unless a real punch lies under it', () => {
    const stamp = day({ status: St.HALF_DAY });
    expect(isHalfLeaveStamp(stamp)).toBe(true);
    expect(importSkipReason(stamp, { isHalfDay: true })).toBeNull();
    expect(importSkipReason({ ...stamp, inTime: at, leaveOverriddenSource: Src.FACE_API }, { isHalfDay: true })).toBe('Already has a punch');
    // A short day that was worked is not a stamp.
    expect(isHalfLeaveStamp(day({ status: St.HALF_DAY, source: Src.FACE_API }))).toBe(false);
  });
});
