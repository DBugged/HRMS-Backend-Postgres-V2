import { UsersService } from './users.service';

function build(
  rows: { id: string; email: string; officialEmail: string | null }[],
) {
  const prisma = {
    user: {
      findFirst: async (a: { where: Record<string, string> }) =>
        rows.find((r) =>
          Object.entries(a.where).every(
            ([k, v]) => (r as Record<string, unknown>)[k] === v,
          ),
        ) ?? null,
    },
  };
  return new UsersService(prisma as never);
}

describe('UsersService.findByEmail', () => {
  it("an account's own login email wins over someone else's official email", async () => {
    const service = build([
      {
        id: 'attacker',
        email: 'attacker@x.com',
        officialEmail: 'victim@x.com',
      },
      { id: 'victim', email: 'victim@x.com', officialEmail: null },
    ]);
    expect((await service.findByEmail('victim@x.com'))?.id).toBe('victim');
  });

  it('falls back to the official email when no login email matches', async () => {
    const service = build([
      { id: 'u1', email: 'u1@x.com', officialEmail: 'work@x.com' },
    ]);
    expect((await service.findByEmail(' Work@X.com '))?.id).toBe('u1');
    expect(await service.findByEmail('nobody@x.com')).toBeNull();
  });
});
