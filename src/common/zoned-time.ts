// Purpose: Turn a wall-clock time written in an organisation's timezone (09:30 in Asia/Kolkata) into the real instant.
// Important: Intl only, no date library. A wall-clock time that does not exist (spring-forward gap) or happens twice
//   (fall-back) resolves to one of the two instants; Indian organisations have no daylight saving, so it never arises there.

// Offset of the zone from UTC at an instant, in minutes (Asia/Kolkata = +330).
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round(
    (asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000,
  );
}

// "2026-09-10", 9, 30, 0 written in `timeZone` -> the instant it names.
export function zonedWallTimeToUtc(
  date: string,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, hour, minute, second);
  let result = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60000;
  // The offset can differ at the corrected instant (around a clock change): settle once more.
  const second_ = naive - zoneOffsetMinutes(new Date(result), timeZone) * 60000;
  if (second_ !== result) result = second_;
  return new Date(result);
}
