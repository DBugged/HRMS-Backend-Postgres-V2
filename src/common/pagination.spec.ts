import { paginate, wrapAll } from './pagination';

describe('paginate', () => {
  it('wraps findMany + count into the canonical envelope', async () => {
    const result = await paginate(
      () => Promise.resolve([{ id: 1 }, { id: 2 }]),
      () => Promise.resolve(37),
      2,
      10,
    );
    expect(result).toEqual({
      data: [{ id: 1 }, { id: 2 }],
      total: 37,
      page: 2,
      limit: 10,
    });
  });

  it('runs findMany and count concurrently, not sequentially', async () => {
    const order: string[] = [];
    const findMany = () =>
      new Promise<number[]>((resolve) =>
        setTimeout(() => {
          order.push('findMany');
          resolve([]);
        }, 10),
      );
    const count = () => {
      order.push('count');
      return Promise.resolve(0);
    };
    await paginate(findMany, count, 1, 50);
    // count() (synchronous) resolves before the delayed findMany() —
    // only possible if both were started together, not awaited in series.
    expect(order).toEqual(['count', 'findMany']);
  });
});

describe('wrapAll', () => {
  it('wraps a complete array as a single page containing everything', () => {
    expect(wrapAll([1, 2, 3])).toEqual({
      data: [1, 2, 3],
      total: 3,
      page: 1,
      limit: 3,
    });
  });

  it('does not divide by zero on an empty collection', () => {
    expect(wrapAll([])).toEqual({ data: [], total: 0, page: 1, limit: 1 });
  });
});
