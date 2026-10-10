import { AllocationType } from '@prisma/client';
import { LeaveBalanceService } from './leave-balance.service';

const year = new Date().getFullYear();
const type = (over: Record<string, unknown> = {}) =>
  ({
    id: 'lt1',
    allocationType: AllocationType.FIXED_ANNUAL,
    annualQuota: 12,
    prorateOnJoining: true,
    ...over,
  }) as never;

function fakeTx(rows: Record<string, unknown>[], joining: Date) {
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    tx: {
      leaveBalance: {
        findMany: async () => rows,
        updateMany: async (a: { data: Record<string, unknown> }) => {
          updates.push(a.data);
          return { count: 1 };
        },
      },
      user: {
        findMany: async () => [
          { id: 'e1', joiningDate: joining, name: 'A', employeeId: 'DP-1' },
        ],
      },
    } as never,
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  employeeId: 'e1',
  opening: 0,
  credited: 4,
  availed: 0,
  pending: 0,
  encashed: 0,
  adjusted: 0,
  lastAccrualPeriod: '2026-10',
  ...over,
});

describe('reconcileUpfrontCredit', () => {
  const service = new LeaveBalanceService(null as never);

  it('raises a mid-year joiner who had only accrued 4 to the prorated 6', async () => {
    const { tx, updates } = fakeTx([row()], new Date(Date.UTC(year, 6, 10)));
    const r = await service.reconcileUpfrontCredit(tx, type(), 'org');
    expect(r.changes).toEqual([
      { employeeId: 'e1', employeeCode: 'DP-1', name: 'A', from: 4, to: 6 },
    ]);
    expect(updates[0]).toMatchObject({ credited: 6, closing: 6 });
  });

  it('never drops below what was already taken', async () => {
    const { tx } = fakeTx(
      [row({ credited: 12, availed: 9 })],
      new Date(Date.UTC(year, 6, 10)),
    );
    const r = await service.reconcileUpfrontCredit(tx, type(), 'org');
    expect(r.changes[0].to).toBe(9);
  });

  it('dry run reports but writes nothing', async () => {
    const { tx, updates } = fakeTx([row()], new Date(Date.UTC(year, 6, 10)));
    const r = await service.reconcileUpfrontCredit(tx, type(), 'org', {
      dryRun: true,
    });
    expect(r.changes).toHaveLength(1);
    expect(r.rowsUpdated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('is idempotent and leaves Unlimited / None types alone', async () => {
    const same = fakeTx(
      [row({ credited: 6, lastAccrualPeriod: null })],
      new Date(Date.UTC(year, 6, 10)),
    );
    expect(
      (await service.reconcileUpfrontCredit(same.tx, type(), 'org')).changes,
    ).toEqual([]);
    const none = fakeTx([row()], new Date(Date.UTC(year, 6, 10)));
    const r = await service.reconcileUpfrontCredit(
      none.tx,
      type({ allocationType: AllocationType.NONE }),
      'org',
    );
    expect(r.changes).toEqual([]);
  });
});
