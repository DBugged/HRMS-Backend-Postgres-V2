import { forgetOrganizationStatus, isOrganizationActive } from './org-status';

function reader(rows: Record<string, boolean>) {
  const calls: string[] = [];
  return {
    calls,
    prisma: {
      organization: {
        findFirst: async (a: { where: { id: string } }) => {
          calls.push(a.where.id);
          return a.where.id in rows ? { isActive: rows[a.where.id] } : null;
        },
      },
    },
  };
}

beforeEach(() => forgetOrganizationStatus());

describe('organisation status', () => {
  it('is active for an active organisation and not for a suspended or missing one', async () => {
    const { prisma } = reader({ a: true, s: false });
    expect(await isOrganizationActive(prisma, 'a')).toBe(true);
    expect(await isOrganizationActive(prisma, 's')).toBe(false);
    expect(await isOrganizationActive(prisma, 'ghost')).toBe(false);
  });

  it('is cached for a short time, then looked up again', async () => {
    const { prisma, calls } = reader({ a: true });
    const t0 = 1_000_000;
    await isOrganizationActive(prisma, 'a', t0);
    await isOrganizationActive(prisma, 'a', t0 + 5_000);
    expect(calls).toHaveLength(1);
    await isOrganizationActive(prisma, 'a', t0 + 20_000);
    expect(calls).toHaveLength(2);
  });

  it('forgetting an organisation makes the next check see the new status at once', async () => {
    const rows: Record<string, boolean> = { a: true };
    const { prisma } = reader(rows);
    expect(await isOrganizationActive(prisma, 'a')).toBe(true);
    rows.a = false;
    forgetOrganizationStatus('a');
    expect(await isOrganizationActive(prisma, 'a')).toBe(false);
  });
});
