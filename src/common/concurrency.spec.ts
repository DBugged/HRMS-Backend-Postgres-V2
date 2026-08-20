import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('preserves input order in the results regardless of completion order', async () => {
    const delays = [30, 10, 20, 0, 15];
    const results = await mapWithConcurrency(delays, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('never runs more than `limit` items concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, (n) => {
      seen.push(n);
      return Promise.resolve();
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('propagates a rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (n) => {
        if (n === 2) throw new Error('boom');
        return Promise.resolve(n);
      }),
    ).rejects.toThrow('boom');
  });

  it('handles an empty input array', async () => {
    const results = await mapWithConcurrency([], 5, (n: number) =>
      Promise.resolve(n),
    );
    expect(results).toEqual([]);
  });

  it('handles limit greater than item count', async () => {
    const results = await mapWithConcurrency([1, 2], 10, (n) =>
      Promise.resolve(n * 2),
    );
    expect(results).toEqual([2, 4]);
  });
});
