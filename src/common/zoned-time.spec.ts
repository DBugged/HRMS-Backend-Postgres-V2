import { zoneOffsetMinutes, zonedWallTimeToUtc } from './zoned-time';

describe('zoned time', () => {
  it('knows India is UTC+5:30', () => {
    expect(
      zoneOffsetMinutes(new Date('2026-09-10T00:00:00Z'), 'Asia/Kolkata'),
    ).toBe(330);
  });

  it('reads 09:30 in Asia/Kolkata as 04:00 UTC', () => {
    expect(
      zonedWallTimeToUtc('2026-09-10', 9, 30, 0, 'Asia/Kolkata').toISOString(),
    ).toBe('2026-09-10T04:00:00.000Z');
  });

  it('carries over to the previous UTC day for an early-morning time', () => {
    expect(
      zonedWallTimeToUtc('2026-09-10', 2, 0, 0, 'Asia/Kolkata').toISOString(),
    ).toBe('2026-09-09T20:30:00.000Z');
  });

  it('handles a zone with daylight saving', () => {
    expect(
      zonedWallTimeToUtc(
        '2026-07-01',
        9,
        0,
        0,
        'America/New_York',
      ).toISOString(),
    ).toBe('2026-07-01T13:00:00.000Z');
    expect(
      zonedWallTimeToUtc(
        '2026-01-15',
        9,
        0,
        0,
        'America/New_York',
      ).toISOString(),
    ).toBe('2026-01-15T14:00:00.000Z');
  });

  it('is the identity for UTC', () => {
    expect(
      zonedWallTimeToUtc('2026-09-10', 9, 30, 15, 'UTC').toISOString(),
    ).toBe('2026-09-10T09:30:15.000Z');
  });
});
