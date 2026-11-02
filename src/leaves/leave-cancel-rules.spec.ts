import { LeaveStatus } from '@prisma/client';
import {
  leaveTaken,
  leaveCancelWindowDaysOf,
  ownerCancelOptions,
  ownerCanCancel,
} from './leave-cancel-rules';

// A leave running from 10-11 to 25-11.
const approved = { status: LeaveStatus.APPROVED, startDate: '2026-11-10', endDate: '2026-11-25' };

describe('leave cancel rules', () => {
  it('reads the grace window, defaulting to 0 for anything unset or invalid', () => {
    expect(leaveCancelWindowDaysOf(undefined)).toBe(0);
    expect(leaveCancelWindowDaysOf(null)).toBe(0);
    expect(leaveCancelWindowDaysOf(-1)).toBe(0);
    expect(leaveCancelWindowDaysOf(2.5)).toBe(0);
    expect(leaveCancelWindowDaysOf(500)).toBe(0);
    expect(leaveCancelWindowDaysOf(5)).toBe(5);
  });

  it('lets the owner cancel an approved leave only before it starts when the window is 0', () => {
    expect(ownerCanCancel(approved, '2026-11-09', 0)).toBe(true);
    expect(ownerCanCancel(approved, '2026-11-10', 0)).toBe(false);
    expect(ownerCanCancel(approved, '2026-12-01', 0)).toBe(false);
  });

  it('extends that by the grace days', () => {
    expect(ownerCanCancel(approved, '2026-11-12', 3)).toBe(true);
    expect(ownerCanCancel(approved, '2026-11-13', 3)).toBe(false);
  });

  it('always lets the owner cancel a pending or returned leave', () => {
    for (const status of [LeaveStatus.PENDING, LeaveStatus.RETURNED]) {
      expect(ownerCanCancel({ status, startDate: '2026-01-01', endDate: '2026-01-01' }, '2026-11-10', 0)).toBe(true);
    }
    expect(ownerCanCancel({ status: LeaveStatus.REJECTED, startDate: '2026-12-01', endDate: '2026-12-01' }, '2026-11-10', 0)).toBe(false);
  });

  it('offers a cancellation request once direct cancel is closed, once', () => {
    expect(ownerCancelOptions(approved, '2026-11-20', 0)).toEqual({ canCancel: false, canRequestCancel: true });
    expect(ownerCancelOptions({ ...approved, cancelRequestedAt: new Date() }, '2026-11-20', 0)).toEqual({ canCancel: false, canRequestCancel: false });
    // An Admin/HR owner cancels directly even after the leave has started - no request that would sit pending.
    expect(ownerCancelOptions(approved, '2026-11-20', 0, true)).toEqual({ canCancel: true, canRequestCancel: false });
    expect(ownerCancelOptions(approved, '2026-11-01', 0)).toEqual({ canCancel: true, canRequestCancel: false });
  });

  it('offers no cancellation request for a leave already taken in full (its last day has passed)', () => {
    expect(ownerCancelOptions(approved, '2026-11-25', 0)).toEqual({ canCancel: false, canRequestCancel: true }); // last day
    expect(ownerCancelOptions(approved, '2026-11-26', 0)).toEqual({ canCancel: false, canRequestCancel: false });
    expect(leaveTaken(approved, '2026-11-26')).toBe(true);
  });
});
