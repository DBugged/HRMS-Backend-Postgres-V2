import { UsersService } from './users.service';

function build(rows: { id: string; email: string }[]) {
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
  it('finds an account by its login email, ignoring case and spaces', async () => {
    const service = build([{ id: 'u1', email: 'u1@x.com' }]);
    expect((await service.findByEmail(' U1@X.com '))?.id).toBe('u1');
    expect(await service.findByEmail('nobody@x.com')).toBeNull();
  });

  it('does not look an account up by any other address', async () => {
    const service = build([{ id: 'u1', email: 'u1@x.com' }]);
    expect(await service.findByEmail('work@x.com')).toBeNull();
  });
});
