import { defaultChecklistMeta, defaultDueDate, isOverdue, itemsDone, readyToComplete, waitingFor, type CaseState } from './offboarding-checklist';

const base: CaseState = {
  assetsReturned: true, accessRevoked: true, interviewNeeded: true, exitInterviewDone: true,
  teamHandedOver: true, settlementPaid: true, settlementMatchesLastWorkingDay: true,
};

describe('defaultDueDate', () => {
  it('is two days before the last working day', () => expect(defaultDueDate('2026-12-20', '2026-12-01')).toBe('2026-12-18'));
  it('is never in the past: an exit started late is due now', () => {
    expect(defaultDueDate('2026-12-20', '2026-12-19')).toBe('2026-12-19');
    expect(defaultDueDate('2026-12-20', '2026-12-25')).toBe('2026-12-20');
  });
});

describe('defaultChecklistMeta', () => {
  it('HR owns assets, access and the interview; the manager owns the handover', () => {
    const m = defaultChecklistMeta({ initiatorId: 'hr1', managerId: 'm1', lastWorkingDay: '2026-12-20', today: '2026-12-01' });
    expect(m.assets).toEqual({ ownerId: 'hr1', dueDate: '2026-12-18' });
    expect(m.handover).toEqual({ ownerId: 'm1', dueDate: '2026-12-18' });
    expect(m.interview?.ownerId).toBe('hr1');
  });
  it('falls back to HR for the handover when there is no manager', () => {
    expect(defaultChecklistMeta({ initiatorId: 'hr1', managerId: null, lastWorkingDay: '2026-12-20', today: '2026-12-01' }).handover?.ownerId).toBe('hr1');
  });
});

describe('isOverdue', () => {
  it('only an unfinished item past its date', () => {
    expect(isOverdue('2026-12-01', '2026-12-02', false)).toBe(true);
    expect(isOverdue('2026-12-01', '2026-12-02', true)).toBe(false);
    expect(isOverdue('2026-12-02', '2026-12-02', false)).toBe(false);
    expect(isOverdue(null, '2026-12-02', false)).toBe(false);
  });
});

describe('readyToComplete', () => {
  it('needs every item and a paid settlement', () => {
    expect(readyToComplete(base)).toBe(true);
    expect(readyToComplete({ ...base, assetsReturned: false })).toBe(false);
    expect(readyToComplete({ ...base, teamHandedOver: false })).toBe(false);
    expect(readyToComplete({ ...base, settlementPaid: false })).toBe(false);
    expect(readyToComplete({ ...base, settlementMatchesLastWorkingDay: false })).toBe(false);
  });
  it('a termination without an interview does not wait for one', () => {
    expect(itemsDone({ ...base, interviewNeeded: false, exitInterviewDone: false }).interview).toBe(true);
    expect(readyToComplete({ ...base, interviewNeeded: false, exitInterviewDone: false })).toBe(true);
  });
});

describe('waitingFor', () => {
  it('lists what is open', () => {
    expect(waitingFor({ ...base, assetsReturned: false, settlementPaid: false })).toEqual(['All company assets returned', 'Final settlement paid']);
    expect(waitingFor(base)).toEqual([]);
  });
});
