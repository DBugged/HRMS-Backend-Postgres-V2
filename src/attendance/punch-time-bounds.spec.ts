import { assertPunchTimeSane } from './punch-time-bounds';

const now = new Date('2026-10-13T10:00:00Z');

describe('device punch time bounds', () => {
  it('accepts now, a few minutes ago and a backlog of days', () => {
    expect(() => assertPunchTimeSane(now, now)).not.toThrow();
    expect(() =>
      assertPunchTimeSane(new Date('2026-10-13T09:55:00Z'), now),
    ).not.toThrow();
    expect(() =>
      assertPunchTimeSane(new Date('2026-10-01T09:00:00Z'), now),
    ).not.toThrow();
  });

  it('rejects the future and anything older than 45 days', () => {
    expect(() =>
      assertPunchTimeSane(new Date('2026-10-13T10:30:00Z'), now),
    ).toThrow(/future/);
    expect(() =>
      assertPunchTimeSane(new Date('2026-08-01T09:00:00Z'), now),
    ).toThrow(/too old/);
    expect(() => assertPunchTimeSane(new Date('nope'), now)).toThrow(/valid/);
  });
});
