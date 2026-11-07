import { buildTimeline, namesLine, statusGroup, waitingDays } from './my-requests-logic';

describe('my requests rules', () => {
  it('groups statuses', () => {
    expect(['PENDING', 'RETURNED'].map(statusGroup)).toEqual(['pending', 'pending']);
    expect(['APPROVED', 'PAID', 'AVAILED', 'ACTIVE'].map(statusGroup)).toEqual(['approved', 'approved', 'approved', 'approved']);
    expect(statusGroup('REJECTED')).toBe('rejected');
    expect(['CANCELLED', 'EXPIRED', 'none'].map(statusGroup)).toEqual(['past', 'past', 'past']);
  });
  it('counts whole days waited, never negative', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(waitingDays(new Date('2026-11-10T01:00:00Z'), now)).toBe(0);
    expect(waitingDays(new Date('2026-11-07T01:00:00Z'), now)).toBe(3);
    expect(waitingDays(new Date('2026-11-12T01:00:00Z'), now)).toBe(0);
  });
  it('shortens a long list of approvers', () => {
    expect(namesLine(['A', 'B'])).toEqual(['A', 'B']);
    expect(namesLine(['A', 'B', 'C', 'D', 'E'])).toEqual(['A', 'B', 'C', '2 more']);
  });
  it('builds a timeline that waits, or ends with the decision', () => {
    const base = { submittedAt: new Date('2026-11-01T00:00:00Z'), decidedBy: null, decidedAt: null, note: null };
    const waiting = buildTimeline({ ...base, status: 'PENDING', waitingWith: ['Asha', 'Ravi'] });
    expect(waiting.map((e) => e.label)).toEqual(['Submitted', 'Waiting for Asha, Ravi']);
    const done = buildTimeline({ ...base, status: 'REJECTED', decidedBy: 'Asha', decidedAt: new Date('2026-11-03T00:00:00Z'), note: 'Not enough balance', waitingWith: [], firstApproval: { by: 'Ravi', at: new Date('2026-11-02T00:00:00Z') } });
    expect(done.map((e) => e.label)).toEqual(['Submitted', 'First approval', 'Rejected']);
    expect(done[2]).toMatchObject({ by: 'Asha', note: 'Not enough balance' });
  });
});
