import { exitAccessEnded, organizationToday } from './exit-access';

describe('exitAccessEnded', () => {
  it('access continues through the last working day and ends the day after', () => {
    expect(exitAccessEnded('2026-12-10', '2026-12-09')).toBe(false);
    expect(exitAccessEnded('2026-12-10', '2026-12-10')).toBe(false);
    expect(exitAccessEnded('2026-12-10', '2026-12-11')).toBe(true);
  });
  it('no exit date means access continues', () => {
    expect(exitAccessEnded(null, '2026-12-11')).toBe(false);
    expect(exitAccessEnded(undefined, '2026-12-11')).toBe(false);
  });
});

describe('organizationToday', () => {
  it("is today in the organisation's own zone, and is cached for a minute", async () => {
    let reads = 0;
    const prisma = { organization: { findFirst: async () => { reads++; return { timezone: 'Asia/Kolkata' }; } } };
    // 20:00 UTC on 10 Dec is already 01:30 on 11 Dec in India.
    const at = Date.parse('2026-12-10T20:00:00Z');
    expect(await organizationToday(prisma as never, 'org-x', at)).toBe('2026-12-11');
    expect(await organizationToday(prisma as never, 'org-x', at + 1000)).toBe('2026-12-11');
    expect(reads).toBe(1);
  });
});
