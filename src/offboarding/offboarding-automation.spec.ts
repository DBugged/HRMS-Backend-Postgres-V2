import { OffboardingAutomationService } from './offboarding-automation.service';

type Row = Record<string, any>;

function build(o: { settlement?: Row | null; policies?: Row; ready?: boolean; failCalculate?: boolean; lwd?: string; checklistMeta?: Row } = {}) {
  const calls = { calculate: [] as Row[], link: [] as Row[], complete: [] as Row[], notifyHr: [] as Row[], notifyOnce: [] as Row[], audit: [] as Row[] };
  const kase: Row = {
    id: 'c1', employeeId: 'e1', initiatedById: 'hr1', status: 'IN_PROGRESS', lastWorkingDay: o.lwd ?? '2026-11-10',
    settlementId: null, checklistMeta: o.checklistMeta ?? {}, employee: { id: 'e1', name: 'Asha', employeeId: 'DP-1' }, settlement: null,
  };
  const prisma: Row = {
    organization: { findFirst: async () => ({ policies: o.policies ?? {} }) },
    offboardingCase: {
      findMany: async () => [kase],
      updateMany: async (a: Row) => { calls.link.push(a.data); return { count: 1 }; },
    },
    user: { findFirst: async () => ({ id: 'hr1', role: 'HR' }) },
    settlement: { findFirst: async () => o.settlement ?? null },
    notification: { findFirst: async () => null },
  };
  const offboarding: Row = {
    reconcile: async () => ({ ready: !!o.ready, becameReady: false }),
    complete: async (...a: unknown[]) => { calls.complete.push(a); },
    notifyHr: async (...a: unknown[]) => { calls.notifyHr.push(a); },
    notifyOnce: async (...a: unknown[]) => { calls.notifyOnce.push(a); },
    findOne: async () => ({ checklist: [{ key: 'assets', done: false }, { key: 'access', done: false }, { key: 'handover', done: true }, { key: 'interview', done: false, notNeeded: false }] }),
  };
  const settlements: Row = {
    calculate: async (...a: unknown[]) => {
      calls.calculate.push(a);
      if (o.failCalculate) throw new Error('The regular 11/2026 payroll run is calculated but not locked.');
      return { id: 's1' };
    },
  };
  const stub = <T>(x: T) => x as never;
  const svc = new OffboardingAutomationService(stub(prisma), stub(offboarding), stub(settlements), stub({ log: async (e: Row) => calls.audit.push(e) }), stub({ logEvent: async () => undefined }));
  return { svc, calls };
}

describe('OffboardingAutomationService.runForOrg', () => {
  it('prepares the final settlement draft the morning after the last working day, as the system, and tells HR', async () => {
    const { svc, calls } = build();
    const r = await svc.runForOrg('org', '2026-11-11', 9);
    expect(r.prepared).toBe(1);
    expect(calls.calculate[0][3]).toEqual({ system: true });
    expect(calls.link.some((d) => d.settlementId === 's1' && d.fnfPreparedAt)).toBe(true);
    expect(calls.notifyHr.some((a) => String(a[2]).startsWith('Final settlement draft ready'))).toBe(true);
    expect(calls.audit[0]).toMatchObject({ action: 'FNF_AUTO_PREPARED', details: { automatic: true } });
  });

  it('does nothing on the last working day itself, or at night', async () => {
    expect((await build().svc.runForOrg('org', '2026-11-10', 9)).prepared).toBe(0);
    const night = build();
    expect((await night.svc.runForOrg('org', '2026-11-11', 3)).prepared).toBe(0);
    expect(night.calls.calculate).toHaveLength(0);
  });

  it('links the settlement already made for that last working day instead of calculating again', async () => {
    const { svc, calls } = build({ settlement: { id: 's9', lastWorkingDay: '2026-11-10' } });
    const r = await svc.runForOrg('org', '2026-11-11', 9);
    expect(r.prepared).toBe(0);
    expect(calls.calculate).toHaveLength(0);
    expect(calls.link.some((d) => d.settlementId === 's9')).toBe(true);
  });

  it('leaves the draft to HR when the company switched automatic preparation off', async () => {
    const { svc, calls } = build({ policies: { autoPrepareFnf: false } });
    await svc.runForOrg('org', '2026-11-11', 9);
    expect(calls.calculate).toHaveLength(0);
  });

  it('tells HR why a draft could not be prepared, and keeps going', async () => {
    const { svc, calls } = build({ failCalculate: true });
    const r = await svc.runForOrg('org', '2026-11-11', 9);
    expect(r.prepared).toBe(0);
    expect(calls.notifyHr.some((a) => String(a[2]).startsWith('Final settlement could not be prepared') && String(a[3]).includes('not locked'))).toBe(true);
  });

  it('completes a ready case by itself only when the company turned that on', async () => {
    const off = build({ ready: true });
    expect((await off.svc.runForOrg('org', '2026-11-11', 9)).completed).toBe(0);
    const on = build({ ready: true, policies: { autoCompleteExit: true } });
    expect((await on.svc.runForOrg('org', '2026-11-11', 9)).completed).toBe(1);
    expect(on.calls.audit.some((e) => e.action === 'EXIT_AUTO_COMPLETED')).toBe(true);
  });

  it('reminds the owner of an open item that is due, once a day', async () => {
    const { svc, calls } = build({ checklistMeta: { assets: { ownerId: 'o1', dueDate: '2026-11-09' }, handover: { ownerId: 'o2', dueDate: '2026-11-09' } } });
    await svc.runForOrg('org', '2026-11-11', 9);
    const titles = calls.notifyOnce.map((a) => String(a[2]));
    expect(titles.some((t) => t.startsWith('Exit task overdue: All company assets returned'))).toBe(true);
    // handover is already done, so its owner is not reminded
    expect(calls.notifyOnce.some((a) => (a[1] as string[]).includes('o2'))).toBe(false);
  });
});
