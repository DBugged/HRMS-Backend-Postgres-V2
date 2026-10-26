import { defaultJoiningMeta, dueDateFor, isJoiningOverdue, joiningDone, needsJoiningChecklist } from './joining-checklist';

describe('joining checklist rules', () => {
  it('sets setup steps due on the joining day and the joiner\'s own steps a week later', () => {
    expect(dueDateFor('assets', '2026-11-10', '2026-11-01')).toBe('2026-11-10');
    expect(dueDateFor('idCard', '2026-11-10', '2026-11-01')).toBe('2026-11-11');
    expect(dueDateFor('documents', '2026-11-10', '2026-11-01')).toBe('2026-11-17');
  });

  it('never sets a due date in the past: someone added late is due at once', () => {
    expect(dueDateFor('assets', '2026-11-01', '2026-11-12')).toBe('2026-11-12');
  });

  it('gives HR the setup steps and the manager the introduction, and nobody the joiner\'s own steps', () => {
    const m = defaultJoiningMeta({ hrId: 'hr1', managerId: 'm1', joiningDate: '2026-11-10', today: '2026-11-01' });
    expect(m.assets?.ownerId).toBe('hr1');
    expect(m.workEmail?.ownerId).toBe('hr1');
    expect(m.idCard?.ownerId).toBe('hr1');
    expect(m.introduction?.ownerId).toBe('m1');
    expect(m.documents?.ownerId).toBeNull();
    expect(m.profile?.ownerId).toBeNull();
  });

  it('falls back to HR for the introduction when there is no manager', () => {
    expect(defaultJoiningMeta({ hrId: 'hr1', managerId: null, joiningDate: '2026-11-10', today: '2026-11-01' }).introduction?.ownerId).toBe('hr1');
  });

  it('ticks the system steps from what it sees, and the rest only when their owner ticks them', () => {
    const meta = defaultJoiningMeta({ hrId: 'hr1', managerId: 'm1', joiningDate: '2026-11-10', today: '2026-11-01' });
    const seen = joiningDone(meta, { hasAllocatedAsset: true, documentsUploaded: true, profileCompleted: false });
    expect(seen).toEqual({ assets: true, workEmail: false, idCard: false, documents: true, profile: false, introduction: false });
    meta.workEmail = { ...meta.workEmail!, doneAt: '2026-11-10T09:00:00.000Z', doneById: 'hr1' };
    expect(joiningDone(meta, { hasAllocatedAsset: false, documentsUploaded: false, profileCompleted: false }).workEmail).toBe(true);
  });

  it('is overdue only when open and past its due date', () => {
    expect(isJoiningOverdue('2026-11-10', '2026-11-11', false)).toBe(true);
    expect(isJoiningOverdue('2026-11-10', '2026-11-11', true)).toBe(false);
    expect(isJoiningOverdue('2026-11-11', '2026-11-11', false)).toBe(false);
    expect(isJoiningOverdue(null, '2026-11-11', false)).toBe(false);
  });

  it('gives a checklist to people who joined in the last 30 days or join in the next 30', () => {
    expect(needsJoiningChecklist('2026-10-15', '2026-11-01')).toBe(true);
    expect(needsJoiningChecklist('2026-11-20', '2026-11-01')).toBe(true);
    expect(needsJoiningChecklist('2026-09-01', '2026-11-01')).toBe(false);
    expect(needsJoiningChecklist('2026-12-30', '2026-11-01')).toBe(false);
  });
});
