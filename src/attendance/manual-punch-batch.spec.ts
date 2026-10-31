import { BadRequestException } from '@nestjs/common';
import { punchErrorMessage, runInBatches } from './manual-punch-batch';

describe('manual punch batch', () => {
  it('returns one result per item, in order, and keeps going after a failure', async () => {
    const out = await runInBatches(
      [1, 2, 3, 4],
      async (n) => {
        if (n === 2) throw new BadRequestException('Joined later.');
        return n * 10;
      },
      2,
    );
    expect(out).toEqual([
      { ok: true, value: 10 },
      { ok: false, message: 'Joined later.' },
      { ok: true, value: 30 },
      { ok: true, value: 40 },
    ]);
  });

  it('never runs more than the allowed number at once', async () => {
    let running = 0;
    let peak = 0;
    await runInBatches(
      Array.from({ length: 12 }, (_, i) => i),
      async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 2));
        running--;
      },
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    expect(await runInBatches([], async () => 1)).toEqual([]);
  });

  it('turns errors into plain sentences', () => {
    expect(punchErrorMessage(new BadRequestException(['a', 'b']))).toBe('a, b');
    expect(punchErrorMessage(new Error('boom: secret stack'))).toBe(
      'The punch could not be recorded.',
    );
  });
});
