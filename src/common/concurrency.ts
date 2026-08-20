// Runs `fn` over every item in `items` with at most `limit` in flight at
// once, preserving `items`' order in the returned array. Used for
// batch/admin actions (payroll calculate, bulk imports, notify-absentees)
// that loop over every employee in an org doing several DB round-trips
// each — fully sequential, that's minutes for a few hundred employees and
// a real request-timeout risk; unbounded Promise.all risks exhausting the
// DB connection pool. A small bounded concurrency is the middle ground
// that needs no API/response-contract change (still one synchronous
// response, just faster) and no new infrastructure (no queue/worker/
// polling endpoint).
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
