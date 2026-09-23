/**
 * Shared helpers for computing "today" / "yesterday" as a YYYY-MM-DD string
 * in a given IANA timezone (typically an Organization's configured
 * `timezone`, e.g. Organization.timezone at prisma/schema.prisma).
 *
 * These exist because the server's local clock (process timezone) and the
 * UTC clock can both disagree with the org's actual configured timezone,
 * and near a day boundary that disagreement can put a punch/leave/holiday
 * on the wrong calendar day. Always resolve "today" through these helpers
 * using the org's `timezone`, rather than `new Date().toISOString()` or
 * server-local `Date` getters.
 *
 * Implementation uses the built-in `Intl.DateTimeFormat` (no new runtime
 * dependency needed): the `en-CA` locale's short date format is exactly
 * `YYYY-MM-DD`, and `Intl.DateTimeFormat` can format an instant in an
 * arbitrary IANA zone directly.
 */

const DATE_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = DATE_FORMATTER_CACHE.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    DATE_FORMATTER_CACHE.set(timezone, formatter);
  }
  return formatter;
}

/**
 * Formats the given instant (defaults to now) as a YYYY-MM-DD calendar
 * date string as observed in `timezone`.
 */
export function dateStrInOrgTz(
  timezone: string,
  instant: Date = new Date(),
): string {
  return getFormatter(timezone).format(instant);
}

/**
 * Returns "today" (YYYY-MM-DD) as observed in `timezone`, for the given
 * reference instant (defaults to the actual current time). Pass a fixed
 * `instant` in tests to keep this a pure function of its inputs.
 */
export function todayInOrgTz(
  timezone: string,
  instant: Date = new Date(),
): string {
  return dateStrInOrgTz(timezone, instant);
}

/**
 * Returns "yesterday" (YYYY-MM-DD) relative to `instant` (defaults to now),
 * as observed in `timezone`. Computed by subtracting 24 hours from the
 * instant and formatting in-zone, which is safe for a day-string
 * computation (DST transitions do not change the calendar date that a
 * fixed 24h-earlier instant falls on for the purposes of this subtraction,
 * since we only ever read the resulting date fields, not wall-clock time).
 */
export function yesterdayInOrgTz(
  timezone: string,
  instant: Date = new Date(),
): string {
  const oneDayEarlier = new Date(instant.getTime() - 24 * 60 * 60 * 1000);
  return dateStrInOrgTz(timezone, oneDayEarlier);
}

/**
 * Timezone offset (in minutes, east-positive — same sign convention as a
 * `GMT+5:30` label) of `timezone` at the given instant.
 */
function offsetMinutesAt(instant: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  // Re-reading the zone's wall-clock fields as if they were UTC and
  // diffing against the real UTC instant gives exactly the zone's offset
  // at that instant (DST included), with no offset-parsing/string-format
  // dependency.
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return (asIfUtc - instant.getTime()) / 60000;
}

/**
 * The UTC instant at which `dateStr` (YYYY-MM-DD) begins in `timezone` —
 * i.e. local midnight of that calendar day, expressed as a UTC `Date`.
 * Needed anywhere a calendar-day string (as returned by `todayInOrgTz`)
 * must be turned back into an absolute UTC range to query an
 * instant-valued column (e.g. Punch.punchTime) — naively treating the
 * date string as UTC midnight (`new Date(dateStr + 'T00:00:00Z')`) is
 * only correct for `timezone === 'UTC'`; for any other zone it's off by
 * the zone's offset, which silently drops rows from a "today" query near
 * the org's own day boundary.
 */
export function startOfDayInOrgTzUtc(dateStr: string, timezone: string): Date {
  const naiveUtc = new Date(`${dateStr}T00:00:00.000Z`);
  const offsetMinutes = offsetMinutesAt(naiveUtc, timezone);
  return new Date(naiveUtc.getTime() - offsetMinutes * 60000);
}

/**
 * `[gte, lt)` UTC instant range spanning the full calendar day `dateStr`
 * as observed in `timezone` — the org-timezone-aware replacement for a
 * plain UTC day-range, for querying an instant column by "which org-local
 * calendar day did this fall on."
 */
export function dayRangeInOrgTz(
  dateStr: string,
  timezone: string,
): { gte: Date; lt: Date } {
  const start = startOfDayInOrgTzUtc(dateStr, timezone);
  const nextDateStr = dateStrInOrgTz(
    timezone,
    new Date(start.getTime() + 36 * 60 * 60 * 1000), // safely into the next local day regardless of DST
  );
  const end = startOfDayInOrgTzUtc(nextDateStr, timezone);
  return { gte: start, lt: end };
}
