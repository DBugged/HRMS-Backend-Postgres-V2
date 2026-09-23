import {
  todayInOrgTz,
  yesterdayInOrgTz,
  dateStrInOrgTz,
  startOfDayInOrgTzUtc,
  dayRangeInOrgTz,
} from './org-date';

describe('org-date helpers', () => {
  describe('todayInOrgTz', () => {
    it('is a pure function of the instant + zone (same inputs -> same output, independent of wall clock)', () => {
      const instant = new Date('2024-06-15T12:00:00.000Z');
      const a = todayInOrgTz('Asia/Kolkata', instant);
      const b = todayInOrgTz('Asia/Kolkata', instant);
      expect(a).toBe(b);
      expect(a).toBe('2024-06-15');
    });

    it('reads as "yesterday" (UTC date) for a negative-offset zone during early UTC morning', () => {
      // 2024-01-10T02:00:00Z is 2024-01-09 18:00 in America/New_York (UTC-5 in Jan, EST).
      const instant = new Date('2024-01-10T02:00:00.000Z');
      expect(todayInOrgTz('UTC', instant)).toBe('2024-01-10');
      expect(todayInOrgTz('America/New_York', instant)).toBe('2024-01-09');
    });

    it('reads as "tomorrow" (relative to UTC date) for a positive-offset zone like Asia/Kolkata late in the UTC day', () => {
      // 2024-01-09T19:00:00Z (7pm UTC) is 2024-01-10T00:30 IST (UTC+5:30) — already the next day.
      const instant = new Date('2024-01-09T19:00:00.000Z');
      expect(todayInOrgTz('UTC', instant)).toBe('2024-01-09');
      expect(todayInOrgTz('Asia/Kolkata', instant)).toBe('2024-01-10');
    });

    it('agrees with UTC when the instant is safely mid-day UTC', () => {
      const instant = new Date('2024-03-01T12:00:00.000Z');
      expect(todayInOrgTz('UTC', instant)).toBe('2024-03-01');
      expect(todayInOrgTz('Asia/Kolkata', instant)).toBe('2024-03-01');
      expect(todayInOrgTz('America/New_York', instant)).toBe('2024-03-01');
    });

    it('defaults to the current instant when none is passed', () => {
      const now = new Date();
      expect(todayInOrgTz('UTC')).toBe(dateStrInOrgTz('UTC', now));
    });
  });

  describe('yesterdayInOrgTz', () => {
    it('returns the calendar day before today in the given zone', () => {
      const instant = new Date('2024-06-15T12:00:00.000Z');
      expect(yesterdayInOrgTz('UTC', instant)).toBe('2024-06-14');
      expect(yesterdayInOrgTz('Asia/Kolkata', instant)).toBe('2024-06-14');
    });

    it('is consistent with todayInOrgTz across a zone-local day boundary', () => {
      // 2024-01-09T19:00:00Z is 2024-01-10 00:30 IST -> "today" in IST is the 10th,
      // so "yesterday" in IST must be the 9th (not the 8th).
      const instant = new Date('2024-01-09T19:00:00.000Z');
      expect(todayInOrgTz('Asia/Kolkata', instant)).toBe('2024-01-10');
      expect(yesterdayInOrgTz('Asia/Kolkata', instant)).toBe('2024-01-09');
    });

    it('is a pure function of instant + zone', () => {
      const instant = new Date('2024-01-10T02:00:00.000Z');
      const a = yesterdayInOrgTz('America/New_York', instant);
      const b = yesterdayInOrgTz('America/New_York', instant);
      expect(a).toBe(b);
      expect(a).toBe('2024-01-08');
    });
  });

  describe('startOfDayInOrgTzUtc', () => {
    it('returns the UTC instant of local midnight for UTC itself', () => {
      expect(startOfDayInOrgTzUtc('2024-06-15', 'UTC').toISOString()).toBe(
        '2024-06-15T00:00:00.000Z',
      );
    });

    it('returns an earlier UTC instant for a positive-offset zone (Asia/Kolkata, +05:30)', () => {
      // IST midnight on the 15th is 18:30 UTC on the 14th.
      expect(
        startOfDayInOrgTzUtc('2024-06-15', 'Asia/Kolkata').toISOString(),
      ).toBe('2024-06-14T18:30:00.000Z');
    });

    it('returns a later UTC instant for a negative-offset zone (America/New_York, EST = -05:00 in Jan)', () => {
      expect(
        startOfDayInOrgTzUtc('2024-01-10', 'America/New_York').toISOString(),
      ).toBe('2024-01-10T05:00:00.000Z');
    });
  });

  describe('dayRangeInOrgTz', () => {
    it('produces a [gte, lt) range whose width is exactly one calendar day for a zone with no DST', () => {
      const { gte, lt } = dayRangeInOrgTz('2024-06-15', 'Asia/Kolkata');
      expect(lt.getTime() - gte.getTime()).toBe(24 * 60 * 60 * 1000);
      expect(gte.toISOString()).toBe('2024-06-14T18:30:00.000Z');
      expect(lt.toISOString()).toBe('2024-06-15T18:30:00.000Z');
    });

    it('places an instant known to be in-zone on the 24th (but UTC-on-the-23rd) inside the range for that zone', () => {
      // 2026-09-23T23:21:50Z is 2026-09-24T04:51:50 in Asia/Kolkata — the
      // exact UTC/org-local day-boundary disagreement this helper exists
      // to resolve for instant-column ("Punch.punchTime") queries.
      const instant = new Date('2026-09-23T23:21:50.000Z');
      const orgToday = todayInOrgTz('Asia/Kolkata', instant);
      expect(orgToday).toBe('2026-09-24');
      const { gte, lt } = dayRangeInOrgTz(orgToday, 'Asia/Kolkata');
      expect(instant.getTime() >= gte.getTime()).toBe(true);
      expect(instant.getTime() < lt.getTime()).toBe(true);
    });
  });
});
