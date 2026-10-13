import { OffboardingService } from './offboarding.service';

type Row = Record<string, any>;

function build(record: Row | null) {
  const prisma = {
    offboardingCase: { findFirst: async () => record },
  };
  const stub = <T>(x: T) => x as never;
  return new OffboardingService(
    stub(prisma),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
  );
}

const actor = {
  id: 'e1',
  organizationId: 'org',
  personalData: { personalEmail: 'asha@gmail.com' },
} as never;

describe('my exit status', () => {
  it('is null when no exit is under way', async () => {
    expect(await build(null).findMine(actor)).toBeNull();
  });

  it('shows progress and a coarse settlement stage, with nothing HR-internal', async () => {
    const mine = await build({
      status: 'IN_PROGRESS',
      lastWorkingDay: '2026-10-30',
      assetsReturned: true,
      accessRevoked: false,
      exitInterviewDone: false,
      exitStatus: 'RELEASED',
      reason: 'private',
      notes: 'hr note',
      assetOverrideNote: 'x',
      exitInterviewResponses: { likedMost: 'secret' },
      settlement: { status: 'DRAFT', netSettlementAmount: 123456 },
    }).findMine(actor);
    expect(mine).toEqual({
      status: 'IN_PROGRESS',
      lastWorkingDay: '2026-10-30',
      assetsReturned: true,
      accessRevoked: false,
      interviewRequired: true,
      exitInterviewDone: false,
      settlementStage: 'BEING_PREPARED',
      documentsGoToPersonalEmail: true,
    });
  });

  it('maps the settlement states, and no interview is required for a termination', async () => {
    const stage = async (settlement: Row | null, exitStatus = 'RELEASED') =>
      (await build({
        status: 'IN_PROGRESS',
        lastWorkingDay: '2026-10-30',
        exitStatus,
        settlement,
      }).findMine(actor))!;
    expect((await stage(null)).settlementStage).toBe('NOT_STARTED');
    expect((await stage({ status: 'PROCESSED' })).settlementStage).toBe(
      'PROCESSED',
    );
    expect((await stage({ status: 'PAID' })).settlementStage).toBe('PAID');
    expect((await stage(null, 'TERMINATED')).interviewRequired).toBe(false);
  });
});
