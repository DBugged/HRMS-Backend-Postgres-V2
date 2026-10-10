import { AssetsService } from './assets.service';

const prisma = {
  user: {
    findMany: async () => [{ id: 'u1', name: 'Asha Rao', employeeId: 'DP-7' }],
  },
  orgListItem: {
    findMany: async () => [
      { id: 'c1', name: 'Laptop' },
      { id: 'c2', name: 'Mobile' },
    ],
  },
};
const service = new AssetsService(prisma as never, null as never);
const run = (entries: { details: unknown }[]) =>
  (
    service as unknown as {
      withReadableDetails: (
        e: unknown[],
        o: string,
      ) => Promise<{ details: Record<string, unknown> }[]>;
    }
  ).withReadableDetails(entries, 'org');

describe('asset history details', () => {
  it('shows the employee by name instead of the id', async () => {
    const [e] = await run([
      {
        details: {
          employeeId: 'u1',
          assetName: 'Dell',
          returnedDate: '2026-10-10',
        },
      },
    ]);
    expect(e.details).toEqual({
      employee: 'Asha Rao (DP-7)',
      assetName: 'Dell',
      returnedDate: '2026-10-10',
    });
  });

  it('shows category names, not ids, in an edit', async () => {
    const [e] = await run([
      {
        details: {
          changes: {
            brand: { from: null, to: 'Dell' },
            categoryId: { from: 'c1', to: 'c2' },
          },
        },
      },
    ]);
    expect(e.details.changes).toEqual({
      brand: { from: null, to: 'Dell' },
      category: { from: 'Laptop', to: 'Mobile' },
    });
  });

  it('a deleted employee does not leak an id', async () => {
    const [e] = await run([{ details: { employeeId: 'gone' } }]);
    expect(e.details).toEqual({ employee: 'Former employee' });
  });
});
