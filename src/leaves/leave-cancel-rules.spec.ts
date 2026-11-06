import { LeaveStatus } from '@prisma/client';
import {
  leaveTaken,
  leaveCancelAfterApprovalDaysOf,
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

import { adminCanCancelOthers } from './leave-cancel-rules';
import { LeaveStatus as LS } from '@prisma/client';

describe('adminCanCancelOthers', () => {
  const leave = (status: LS, startDate: string, endDate = startDate) => ({ status, startDate, endDate });
  it('offers cancel for a waiting or approved leave that has not started', () => {
    expect(adminCanCancelOthers(leave(LS.APPROVED, '2026-11-10', '2026-11-12'), '2026-11-02')).toBe(true);
    expect(adminCanCancelOthers(leave(LS.PENDING, '2026-11-02'), '2026-11-02')).toBe(true);
    expect(adminCanCancelOthers(leave(LS.RETURNED, '2026-12-01'), '2026-11-02')).toBe(true);
  });
  it('does not offer it once the leave has started, or for a leave that is already closed', () => {
    expect(adminCanCancelOthers(leave(LS.APPROVED, '2026-11-01', '2026-11-05'), '2026-11-02')).toBe(false);
    expect(adminCanCancelOthers(leave(LS.APPROVED, '2026-10-20'), '2026-11-02')).toBe(false);
    expect(adminCanCancelOthers(leave(LS.CANCELLED, '2026-11-10'), '2026-11-02')).toBe(false);
    expect(adminCanCancelOthers(leave(LS.REJECTED, '2026-11-10'), '2026-11-02')).toBe(false);
  });

  it('limits the direct cancel to N days after approval when the company sets it', () => {
    const l = { ...approved, approvedOn: '2026-11-01' };
    expect(leaveCancelAfterApprovalDaysOf(undefined)).toBeNull();
    expect(leaveCancelAfterApprovalDaysOf('')).toBeNull();
    expect(leaveCancelAfterApprovalDaysOf(2)).toBe(2);
    expect(leaveCancelAfterApprovalDaysOf(-1)).toBeNull();
    expect(ownerCanCancel(l, '2026-11-03', 0, 2)).toBe(true); // approved 1 Nov, 2 days allowed: 3 Nov is the last day
    expect(ownerCanCancel(l, '2026-11-04', 0, 2)).toBe(false); // too late, even though the leave has not started
    expect(ownerCanCancel(l, '2026-11-04', 0, null)).toBe(true); // no limit set
    expect(ownerCanCancel({ ...approved, approvedOn: null }, '2026-11-09', 0, 0)).toBe(true); // approval day unknown
    // Past the approval window but before it starts: no direct cancel, so a cancellation request is offered instead.
    expect(ownerCancelOptions(l, '2026-11-05', 0, false, 2)).toEqual({ canCancel: false, canRequestCancel: true });
  });
});
