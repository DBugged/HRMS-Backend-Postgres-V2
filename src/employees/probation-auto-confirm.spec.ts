import { ProbationAutoConfirmService, readAutoConfirmProbation } from './probation-auto-confirm.service';

function build(due: any[], admin: any = { id: 'adm', role: 'ADMIN' }) {
  const prisma: any = { user: { findMany: jest.fn().mockResolvedValue(due), findFirst: jest.fn().mockResolvedValue(admin) } };
  const profile: any = { probationDecision: jest.fn().mockResolvedValue({}) };
  return { svc: new ProbationAutoConfirmService(prisma, profile), prisma, profile };
}

describe('ProbationAutoConfirmService', () => {
  it('is off unless the setting is exactly true', () => {
    expect(readAutoConfirmProbation(null)).toBe(false);
    expect(readAutoConfirmProbation({ autoConfirmProbation: 'yes' })).toBe(false);
    expect(readAutoConfirmProbation({ autoConfirmProbation: true })).toBe(true);
  });
  it('confirms everyone whose end date has come, effective on their end date', async () => {
    const { svc, profile } = build([{ id: 'u1', probationEndDate: '2026-10-30' }, { id: 'u2', probationEndDate: '2026-11-02' }]);
    expect(await svc.confirmDueForOrg('o1', '2026-11-02')).toBe(2);
    expect(profile.probationDecision).toHaveBeenCalledWith('u1', expect.objectContaining({ decision: 'confirmed', effectiveDate: '2026-10-30' }), expect.anything(), 'o1');
  });
  it('does nothing when nobody is due or there is no Admin to record it under', async () => {
    expect(await build([]).svc.confirmDueForOrg('o1', '2026-11-02')).toBe(0);
    expect(await build([{ id: 'u1', probationEndDate: '2026-11-01' }], null).svc.confirmDueForOrg('o1', '2026-11-02')).toBe(0);
  });
  it('a failure on one person does not stop the others', async () => {
    const { svc, profile } = build([{ id: 'u1', probationEndDate: '2026-11-01' }, { id: 'u2', probationEndDate: '2026-11-01' }]);
    profile.probationDecision.mockRejectedValueOnce(new Error('exit set'));
    expect(await svc.confirmDueForOrg('o1', '2026-11-02')).toBe(1);
  });
});
