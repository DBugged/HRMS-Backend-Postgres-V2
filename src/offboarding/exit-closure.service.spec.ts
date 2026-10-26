import { ExitClosureService } from './exit-closure.service';

type Row = Record<string, any>;

function build(o: { leaves?: string[]; loans?: string[]; encash?: number; personalEmail?: string | null; runs?: string[] } = {}) {
  const calls = { cancel: [] as string[], reject: [] as Row[], update: [] as Row[], delegations: [] as Row[], mail: [] as Row[], notifyHr: [] as Row[], audit: [] as Row[] };
  const prisma: Row = {
    leave: { findMany: async () => (o.leaves ?? []).map((id) => ({ id })) },
    loan: { findMany: async () => (o.loans ?? []).map((id) => ({ id })) },
    leaveEncashment: { count: async () => o.encash ?? 0 },
    approvalDelegation: { updateMany: async (a: Row) => { calls.delegations.push(a); return { count: 2 }; } },
    offboardingCase: { updateMany: async (a: Row) => { calls.update.push(a.data); return { count: 1 }; } },
    user: { findFirst: async () => ({ name: 'Asha', personalData: o.personalEmail === null ? {} : { personalEmail: o.personalEmail ?? 'asha@gmail.com' } }) },
    payrollRun: { findMany: async () => (o.runs ?? ['r1', 'r2']).map((id) => ({ id })) },
  };
  const stub = <T>(x: T) => x as never;
  const svc = new ExitClosureService(
    stub(prisma),
    stub({ notifyHr: async (...a: unknown[]) => { calls.notifyHr.push(a); } }),
    stub({ cancel: async (id: string) => { calls.cancel.push(id); } }),
    stub({ reject: async (id: string, dto: Row) => { calls.reject.push({ id, dto }); } }),
    stub({ buildPayslipPdfBuffer: async (id: string) => ({ buffer: Buffer.from(id), filename: `${id}.pdf` }) }),
    stub({ send: async (m: Row) => { calls.mail.push(m); } }),
    stub({ renderOccasion: async () => ({ subject: 's', html: 'h' }), defaultFor: () => ({}) }),
    stub({ log: async (e: Row) => { calls.audit.push(e); } }),
    stub({ logEvent: async () => undefined }),
  );
  return { svc, calls };
}

const kase = { id: 'c1', employeeId: 'e1', lastWorkingDay: '2026-11-10', initiatedById: 'hr1', employee: { name: 'Asha', employeeId: 'DP-1' } };
const actor = { id: 'hr1' } as never;

describe('ExitClosureService.clearPending', () => {
  it('cancels pending leaves, closes pending loans, ends delegations and stamps the case', async () => {
    const { svc, calls } = build({ leaves: ['l1', 'l2'], loans: ['n1'] });
    const r = await svc.clearPending(kase, actor, 'org');
    expect(r).toMatchObject({ leavesCancelled: 2, loansClosed: 1, delegationsEnded: 2, leftForHr: 0 });
    expect(calls.cancel).toEqual(['l1', 'l2']);
    expect(String(calls.reject[0].dto.reason).length).toBeGreaterThanOrEqual(10);
    expect(calls.delegations[0].data).toEqual({ isActive: false });
    expect(calls.update.some((d) => d.pendingClearedAt)).toBe(true);
    expect(calls.audit[0]).toMatchObject({ action: 'EXIT_PENDING_CLEARED' });
  });

  it('tells HR about leave encashment requests, which only a person can settle', async () => {
    const { svc, calls } = build({ encash: 1 });
    const r = await svc.clearPending(kase, actor, 'org');
    expect(r.leftForHr).toBe(1);
    expect(calls.notifyHr[0][2]).toBe('Requests still open for Asha');
  });
});

describe('ExitClosureService.sendExitPack', () => {
  it('emails the payslips to the personal address and stamps the case', async () => {
    const { svc, calls } = build();
    expect(await svc.sendExitPack(kase, actor, 'org')).toBe(true);
    expect(calls.mail[0].to).toBe('asha@gmail.com');
    expect(calls.mail[0].attachments).toHaveLength(2);
    expect(calls.update.some((d) => d.exitPackSentAt)).toBe(true);
  });

  it('tells HR when there is no personal email, and sends nothing', async () => {
    const { svc, calls } = build({ personalEmail: null });
    expect(await svc.sendExitPack(kase, actor, 'org')).toBe(false);
    expect(calls.mail).toHaveLength(0);
    expect(calls.notifyHr[0][2]).toBe('Exit documents not emailed: Asha');
  });

  it('sends nothing when there is no payslip yet', async () => {
    const { svc, calls } = build({ runs: [] });
    expect(await svc.sendExitPack(kase, actor, 'org')).toBe(false);
    expect(calls.mail).toHaveLength(0);
  });
});
