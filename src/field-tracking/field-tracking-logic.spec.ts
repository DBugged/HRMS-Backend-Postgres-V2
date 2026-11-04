import {
  cleanPing,
  deriveStatus,
  haversineMeters,
  offlineAfterMinutesFor,
  resolveTrackingSettings,
  summarizeRoute,
  TRACKING,
  validateTrackingSettingsInput,
} from './field-tracking-logic';

const now = new Date('2026-11-05T10:00:00Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000);
// ~111 m per 0.001 degree of latitude.
const p = (min: number, latMilli: number, extra: object = {}) => ({
  latitude: 19 + latMilli / 1000,
  longitude: 72.8,
  recordedAt: at(min),
  speedMps: null,
  ...extra,
});

describe('field tracking: points from the phone', () => {
  it('accepts a good point and clamps battery', () => {
    const r = cleanPing(
      {
        recordedAt: at(-1).toISOString(),
        latitude: 19.07,
        longitude: 72.87,
        accuracyMeters: 12,
        batteryPercent: 140,
      },
      now,
    );
    expect(r.ok && r.ping.batteryPercent).toBe(100);
    expect(r.ok && r.ping.kind).toBe('POINT');
  });
  it('refuses bad times, coordinates and a no-fix 0,0', () => {
    expect(
      cleanPing({ recordedAt: 'nope', latitude: 19, longitude: 72 }, now),
    ).toMatchObject({ ok: false, reason: 'bad time' });
    expect(
      cleanPing(
        { recordedAt: at(60).toISOString(), latitude: 19, longitude: 72 },
        now,
      ),
    ).toMatchObject({ ok: false, reason: 'in the future' });
    expect(
      cleanPing(
        { recordedAt: at(-60 * 40).toISOString(), latitude: 19, longitude: 72 },
        now,
      ),
    ).toMatchObject({ ok: false, reason: 'too old' });
    expect(
      cleanPing(
        { recordedAt: at(-1).toISOString(), latitude: 120, longitude: 72 },
        now,
      ),
    ).toMatchObject({ ok: false, reason: 'bad coordinates' });
    expect(
      cleanPing(
        { recordedAt: at(-1).toISOString(), latitude: 0, longitude: 0 },
        now,
      ),
    ).toMatchObject({ ok: false, reason: 'no fix' });
  });
  it('keeps a location-off marker without coordinates and flags a mock location', () => {
    const off = cleanPing(
      { recordedAt: at(-1).toISOString(), kind: 'LOCATION_OFF' },
      now,
    );
    expect(off.ok && off.ping.latitude).toBeNull();
    const mock = cleanPing(
      {
        recordedAt: at(-1).toISOString(),
        latitude: 19,
        longitude: 72,
        isMock: true,
      },
      now,
    );
    expect(mock.ok && mock.ping.isMock).toBe(true);
  });
});

describe('field tracking: status', () => {
  const pts = (a: ReturnType<typeof p>, b?: ReturnType<typeof p>) => [
    a,
    ...(b ? [b] : []),
  ];
  it('is off shift, no data, location off, offline', () => {
    expect(deriveStatus({ onShift: false, now, last: null, points: [] })).toBe(
      'OFF_SHIFT',
    );
    expect(deriveStatus({ onShift: true, now, last: null, points: [] })).toBe(
      'NO_DATA',
    );
    expect(
      deriveStatus({
        onShift: true,
        now,
        last: { kind: 'LOCATION_OFF', recordedAt: at(-2) },
        points: [],
      }),
    ).toBe('LOCATION_OFF');
    expect(
      deriveStatus({
        onShift: true,
        now,
        last: {
          kind: 'POINT',
          recordedAt: at(-(TRACKING.offlineAfterMinutes + 1)),
        },
        points: pts(p(-30, 0)),
      }),
    ).toBe('OFFLINE');
  });
  it('tells moving from stationary', () => {
    const last = { kind: 'POINT', recordedAt: at(-3) };
    expect(
      deriveStatus({
        onShift: true,
        now,
        last,
        points: pts(p(-3, 0), p(-8, 0.01)),
      }),
    ).toBe('STATIONARY');
    expect(
      deriveStatus({
        onShift: true,
        now,
        last,
        points: pts(p(-3, 5), p(-8, 0)),
      }),
    ).toBe('MOVING');
    expect(
      deriveStatus({
        onShift: true,
        now,
        last,
        points: pts(p(-3, 0, { speedMps: 8 })),
      }),
    ).toBe('MOVING');
  });
});

describe('field tracking: route summary', () => {
  it('measures distance, ignoring jitter and impossible jumps', () => {
    const a = p(0, 0);
    const jitter = p(5, 0.1); // ~11 m
    const real = p(10, 10); // ~1.1 km
    const glitch = { ...p(10.1, 5000), latitude: 40 }; // jumps thousands of km in 6 seconds
    const { distanceMeters } = summarizeRoute([a, jitter, real, glitch]);
    expect(distanceMeters).toBeGreaterThan(1000);
    expect(distanceMeters).toBeLessThan(1300);
  });
  it('finds a stop of 10+ minutes and not a pass-through', () => {
    const stay = [p(0, 0), p(5, 0.2), p(12, 0.1), p(20, 0.3)];
    const travel = [p(30, 10), p(35, 20), p(40, 30)];
    const { stops } = summarizeRoute([...stay, ...travel]);
    expect(stops).toHaveLength(1);
    expect(stops[0].minutes).toBe(20);
  });
  it('haversine is about right', () => {
    expect(
      Math.round(
        haversineMeters(
          { latitude: 19, longitude: 72 },
          { latitude: 19.001, longitude: 72 },
        ),
      ),
    ).toBeGreaterThan(105);
  });
});

describe('company tracking settings', () => {
  it('falls back to the defaults and pulls stray values into range', () => {
    expect(resolveTrackingSettings(null)).toEqual({
      intervalSeconds: 300,
      minDistanceMeters: 200,
      retentionDays: 60,
    });
    expect(
      resolveTrackingSettings({
        intervalSeconds: 5,
        minDistanceMeters: 99999,
        retentionDays: 'x',
      }),
    ).toEqual({
      intervalSeconds: 120,
      minDistanceMeters: 1000,
      retentionDays: 60,
    });
  });

  it('accepts whole numbers in range (as text too) and lists every problem otherwise', () => {
    expect(
      validateTrackingSettingsInput({
        intervalSeconds: '600',
        minDistanceMeters: 100,
        retentionDays: 30,
      }).settings,
    ).toEqual({
      intervalSeconds: 600,
      minDistanceMeters: 100,
      retentionDays: 30,
    });
    const bad = validateTrackingSettingsInput({
      intervalSeconds: 60,
      minDistanceMeters: 100.5,
    });
    expect(bad.settings).toBeUndefined();
    expect(bad.errors).toHaveLength(3);
  });

  it('a longer interval means a longer wait before someone counts as Offline (never under 20 minutes)', () => {
    expect(offlineAfterMinutesFor(300)).toBe(20);
    expect(offlineAfterMinutesFor(120)).toBe(20);
    expect(offlineAfterMinutesFor(900)).toBe(60);
  });
});
