import { OffboardingService } from './offboarding.service';

type Row = Record<string, any>;

function build(o: { settlementStatus?: string; open?: Row | null } = {}) {
  const kase: Row = {
    id: 'c1',
    organizationId: 'org',
    employeeId: 'e1',
    status: 'IN_PROGRESS',
    lastWorkingDay: '2026-10-30',
    settlementId: o.settlementStatus ? 's1' : null,
    settlement: o.settlementStatus
      ? { id: 's1', status: o.settlementStatus, lastWorkingDay: '2026-10-30' }
      : null,
  };
  const audit: Row[] = [];
  const tx: Row = {
    offboardingCase: {
      updateMany: async (a: Row) => {
        Object.assign(kase, a.data);
        if (a.data.settlementId === null) kase.settlement = null;
        return { count: 1 };
      },
    },
    resignation: { updateMany: async () => ({ count: 0 }) },
  };
  const prisma: Row = {
    user: {
      findFirst: async () => ({
        id: 'e1',
        name: 'Asha',
        email: 'a@x.com',
        employmentStatus: 'CONFIRMED',
        joiningDate: new Date('2025-01-15T00:00:00Z'),
      }),
    },
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    offboardingCase: {
      findFirst: async (a: Row) =>
        a.where?.status ? (o.open ?? null) : { ...kase },
      updateMany: tx.offboardingCase.updateMany,
    },
    employeeAsset: { findMany: async () => [] },
    leave: { findFirst: async () => null },
    $transaction: async (cb: (t: Row) => unknown) => cb(tx),
  };
  const stub = <T>(x: T) => x as never;
  const service = new OffboardingService(
    stub(prisma),
    stub({ log: async (e: Row) => audit.push(e) }),
    stub({ logEvent: async () => undefined }),
    stub({ create: async () => undefined }),
    stub({ send: async () => undefined }),
    stub({ renderOccasion: async () => ({ subject: 's', html: 'h' }) }),
  );
  return { service, kase, audit };
}

const actor = { id: 'hr', role: 'HR' } as never;

describe('offboarding: exit rules', () => {
  it('a termination or abscondment must carry a reason', async () => {
    const { service } = build();
    await expect(
      service.initiate(
        {
          employeeId: 'e1',
          lastWorkingDay: '2026-10-30',
          exitStatus: 'TERMINATED',
        } as never,
        actor,
        'org',
      ),
    ).rejects.toThrow(/reason is required to record a termination/);
  });

  it('the last working day cannot precede the joining date', async () => {
    const { service } = build();
    await expect(
      service.initiate(
        {
          employeeId: 'e1',
          lastWorkingDay: '2024-12-31',
          reason: 'x',
        } as never,
        actor,
        'org',
      ),
    ).rejects.toThrow(/before the joining date/);
  });

  it('changing the last working day unlinks a draft settlement and is audited', async () => {
    const { service, kase, audit } = build({ settlementStatus: 'DRAFT' });
    await service.updateLastWorkingDay(
      'c1',
      { lastWorkingDay: '2026-10-20', reason: 'Early release' },
      actor,
      'org',
    );
    expect(kase.lastWorkingDay).toBe('2026-10-20');
    expect(kase.settlementId).toBeNull();
    expect(audit.at(-1)).toMatchObject({
      action: 'OFFBOARDING_LWD_CHANGED',
      details: {
        from: '2026-10-30',
        to: '2026-10-20',
        settlementUnlinked: true,
      },
    });
  });

  it('a processed settlement has to be reversed before the date can change', async () => {
    const { service } = build({ settlementStatus: 'PROCESSED' });
    await expect(
      service.updateLastWorkingDay(
        'c1',
        { lastWorkingDay: '2026-10-20', reason: 'Early release' },
        actor,
        'org',
      ),
    ).rejects.toThrow(/reverse it before changing the date/);
  });
});
