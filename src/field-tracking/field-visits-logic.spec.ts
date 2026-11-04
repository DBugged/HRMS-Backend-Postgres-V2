import {
  addDays,
  assessCheckIn,
  cleanVisitInput,
  daysBetween,
  summarizeVisits,
  visitMinutes,
} from './field-visits-logic';

const client = { latitude: 19.07, longitude: 72.87, radiusMeters: 150 };

describe('field visits: check-in', () => {
  it('is within range at the client and outside when far away', () => {
    expect(
      assessCheckIn(client, { latitude: 19.0701, longitude: 72.8701 })
        .withinRange,
    ).toBe(true);
    const far = assessCheckIn(client, { latitude: 19.08, longitude: 72.87 });
    expect(far.withinRange).toBe(false);
    expect(far.distanceMeters).toBeGreaterThan(1000);
  });
  it('lets a poor GPS fix count for up to 100 m of its own error, no more', () => {
    // ~220 m away: outside 150, inside 150 + 100 when the fix is that rough, outside when the error is small.
    const at = { latitude: 19.072, longitude: 72.87 };
    expect(
      assessCheckIn(client, { ...at, accuracyMeters: 5 }).withinRange,
    ).toBe(false);
    expect(
      assessCheckIn(client, { ...at, accuracyMeters: 90 }).withinRange,
    ).toBe(true);
    expect(
      assessCheckIn(client, { ...at, accuracyMeters: 5000 }).withinRange,
    ).toBe(true); // capped at 100: 220 < 250
    expect(
      assessCheckIn(client, {
        latitude: 19.075,
        longitude: 72.87,
        accuracyMeters: 5000,
      }).withinRange,
    ).toBe(false); // ~550 m
  });
  it('cannot judge a client with no location', () => {
    expect(
      assessCheckIn(
        { latitude: null, longitude: null, radiusMeters: 150 },
        { latitude: 19, longitude: 72 },
      ),
    ).toEqual({ distanceMeters: null, withinRange: null });
  });
});

describe('field visits: what a visit may contain', () => {
  it('needs a client; trims; defaults the radius', () => {
    expect(cleanVisitInput({ clientName: '  ' })).toMatchObject({ ok: false });
    const r = cleanVisitInput({ clientName: ' Acme Ltd ', address: 'Andheri' });
    expect(r.ok && r.value).toMatchObject({
      clientName: 'Acme Ltd',
      radiusMeters: 150,
      latitude: null,
    });
  });
  it('wants latitude and longitude together and in range', () => {
    expect(cleanVisitInput({ clientName: 'A', latitude: 19 })).toMatchObject({
      ok: false,
    });
    expect(
      cleanVisitInput({ clientName: 'A', latitude: 120, longitude: 72 }),
    ).toMatchObject({ ok: false });
    expect(
      cleanVisitInput({ clientName: 'A', latitude: 19, longitude: 72 }),
    ).toMatchObject({ ok: true });
  });
  it('keeps the allowed distance sensible', () => {
    expect(
      cleanVisitInput({ clientName: 'A', radiusMeters: 10 }),
    ).toMatchObject({ ok: false });
    expect(
      cleanVisitInput({ clientName: 'A', radiusMeters: 5000 }),
    ).toMatchObject({ ok: false });
    expect(
      cleanVisitInput({ clientName: 'A', radiusMeters: 300 }),
    ).toMatchObject({ ok: true });
  });
});

describe('field visits: totals and dates', () => {
  it('counts statuses, outside-range check-ins and minutes at clients', () => {
    const s = summarizeVisits([
      { status: 'COMPLETED', durationMinutes: 45, checkInWithinRange: true },
      { status: 'COMPLETED', durationMinutes: 30, checkInWithinRange: false },
      { status: 'MISSED', durationMinutes: null, checkInWithinRange: null },
      { status: 'PLANNED', durationMinutes: null, checkInWithinRange: null },
    ]);
    expect(s).toMatchObject({
      completed: 2,
      missed: 1,
      planned: 1,
      outsideRange: 1,
      minutesAtClients: 75,
    });
  });
  it('does calendar arithmetic and minutes', () => {
    expect(addDays('2026-11-30', 2)).toBe('2026-12-02');
    expect(daysBetween('2026-11-01', '2026-11-05')).toBe(4);
    expect(
      visitMinutes(
        new Date('2026-11-05T10:00:00Z'),
        new Date('2026-11-05T10:47:00Z'),
      ),
    ).toBe(47);
    expect(
      visitMinutes(
        new Date('2026-11-05T10:00:00Z'),
        new Date('2026-11-05T09:00:00Z'),
      ),
    ).toBe(0);
  });
});
