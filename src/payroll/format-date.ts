/**
 * Pure port of the original release's utils/formatDate.js — human-facing date
 * text for generated documents, reports, and notification/email messages.
 * Stored values (DB columns, API JSON) are untouched; this only formats
 * text meant to be read.
 *
 * The date/time pattern is org-configurable (Organization Settings >
 * General Settings > Date Format / Time Format — see
 * frontend/src/components/organization/PoliciesStep.tsx, stored on
 * Organization.policies.{dateFormat,timeFormat}) rather than hardcoded —
 * defaults (DD-MM-YYYY, 12-hour) apply whenever a caller doesn't resolve
 * and pass the org's actual setting, so every existing call site keeps
 * working unchanged. Use resolveOrgDateTimeFormat() to look it up.
 */
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

// The date format is fixed at DD-MM-YYYY for every organisation (General Settings no longer offers a choice). The
// type keeps the other names so older callers and stored settings still type-check, but they are never honoured.
export type DateFormatPattern = 'DD-MM-YYYY' | 'MM-DD-YYYY' | 'YYYY-MM-DD';
export type TimeFormatPattern = '12' | '24';

export const DEFAULT_DATE_FORMAT: DateFormatPattern = 'DD-MM-YYYY';
export const DEFAULT_TIME_FORMAT: TimeFormatPattern = '12';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDateObject(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    if (DATE_ONLY_RE.test(value)) {
      // Parsed as a local date (not UTC) so the displayed day never shifts.
      const [y, m, d] = value.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      return Number.isNaN(dt.getTime()) ? null : dt;
    }
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function isTimeFormatPattern(v: unknown): v is TimeFormatPattern {
  return v === '12' || v === '24';
}

// The zone a timestamp is read in when the caller has not resolved the organisation's (the platform default, the same
// fallback the rest of the backend uses) - never the server's own clock zone, which differs between deployments.
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = ZONE_FORMATTERS.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      return zoneFormatter(DEFAULT_TIMEZONE); // unknown zone name
    }
    ZONE_FORMATTERS.set(timeZone, f);
  }
  return f;
}

interface CalendarParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

// The calendar day and clock time of an instant as seen in `timeZone`.
function partsInZone(date: Date, timeZone: string): CalendarParts {
  const get: Record<string, number> = {};
  for (const p of zoneFormatter(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') get[p.type] = Number(p.value);
  }
  return {
    y: get.year,
    mo: get.month,
    d: get.day,
    h: get.hour,
    mi: get.minute,
  };
}

const isUtcMidnight = (d: Date) =>
  d.getUTCHours() === 0 &&
  d.getUTCMinutes() === 0 &&
  d.getUTCSeconds() === 0 &&
  d.getUTCMilliseconds() === 0;

const dmy = (p: { y: number; mo: number; d: number }) =>
  `${pad2(p.d)}-${pad2(p.mo)}-${String(p.y)}`;

// Formats any date-like value (YYYY-MM-DD string, ISO datetime string, or Date) as DD-MM-YYYY (the format is fixed).
// A plain YYYY-MM-DD string is a calendar date and is never shifted. A timestamp is read as the day it is in
// `timeZone` (the organisation's; defaults to the platform zone, never the server's), so the same punch shows the
// same day wherever the backend runs. A Date stored at exactly 00:00:00 UTC is a date-only column (joining date and
// the like), so it keeps its UTC day rather than being moved by a negative-offset zone.
// A date for a sentence a person reads (an error, a hint): DD-MM-YYYY, or the text as it came when it is not a real
// date (so a message never loses what was typed).
export const dmyText = (value: unknown): string =>
  formatDateDisplay(value, value == null ? '' : String(value));

export function formatDateDisplay(
  value: unknown,
  fallback = '',
  dateFormat: DateFormatPattern = DEFAULT_DATE_FORMAT,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  void dateFormat; // fixed format - see DateFormatPattern
  if (typeof value === 'string' && DATE_ONLY_RE.test(value)) {
    const [y, mo, d] = value.split('-').map(Number);
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (
      probe.getUTCFullYear() !== y ||
      probe.getUTCMonth() !== mo - 1 ||
      probe.getUTCDate() !== d
    ) {
      return fallback;
    }
    return dmy({ y, mo, d });
  }
  const date = toDateObject(value);
  if (!date) return fallback;
  if (isUtcMidnight(date)) {
    return dmy({
      y: date.getUTCFullYear(),
      mo: date.getUTCMonth() + 1,
      d: date.getUTCDate(),
    });
  }
  return dmy(partsInZone(date, timeZone));
}

// Same as formatDateDisplay but also appends the time (in the same zone), per `timeFormat`
// (org-configurable, defaults to 12-hour).
export function formatDateTimeDisplay(
  value: unknown,
  fallback = '',
  dateFormat: DateFormatPattern = DEFAULT_DATE_FORMAT,
  timeFormat: TimeFormatPattern = DEFAULT_TIME_FORMAT,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  void dateFormat; // fixed format - see DateFormatPattern
  const d = toDateObject(value);
  if (!d) return fallback;
  const p = partsInZone(d, timeZone);
  const datePart = dmy(p);
  const minutes = pad2(p.mi);
  if (timeFormat === '24') {
    return `${datePart}, ${pad2(p.h)}:${minutes}`;
  }
  const ampm = p.h >= 12 ? 'PM' : 'AM';
  return `${datePart}, ${pad2(p.h % 12 || 12)}:${minutes} ${ampm}`;
}

export interface OrgDateTimeFormat {
  dateFormat: DateFormatPattern;
  timeFormat: TimeFormatPattern;
  /** The organisation's IANA timezone: timestamps are shown as the day/time they are in this zone. */
  timeZone: string;
}

// Looks up an org's configured date/time format (Organization.policies),
// falling back to the defaults above when unset/malformed. Callers that
// build notification/email/export text pass the result into
// formatDateDisplay/formatDateTimeDisplay instead of relying on the
// hardcoded defaults, so "whatever is set in General Settings" actually
// takes effect everywhere text gets generated.
export async function resolveOrgDateTimeFormat(
  scopedPrisma: Pick<ExtendedPrismaClient, 'organization'>,
  organizationId: string,
): Promise<OrgDateTimeFormat> {
  const org = await scopedPrisma.organization.findFirst({
    where: { id: organizationId },
    select: { policies: true, timezone: true },
  });
  const policies = (org?.policies ?? {}) as {
    dateFormat?: unknown;
    timeFormat?: unknown;
  };
  return {
    // Fixed: whatever an older organisation saved, dates are DD-MM-YYYY.
    dateFormat: DEFAULT_DATE_FORMAT,
    timeFormat: isTimeFormatPattern(policies.timeFormat)
      ? policies.timeFormat
      : DEFAULT_TIME_FORMAT,
    timeZone: org?.timezone || DEFAULT_TIMEZONE,
  };
}

// A clock time ("09:30 AM" / "09:30") as observed in the org's timezone. The Date getters used elsewhere in this
// file read the SERVER's local zone, which is wrong for punch times whenever the server runs in a different zone
// from the org (e.g. UTC server, IST org: every time came out 5h30m early).
export function formatTimeInZone(
  value: unknown,
  timezone: string,
  timeFormat: TimeFormatPattern = DEFAULT_TIME_FORMAT,
  fallback = '',
): string {
  const d = toDateObject(value);
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: timeFormat === '24' ? 'h23' : 'h12',
  })
    .format(d)
    .replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());
}

// The org's timezone and time format, for exports that print punch times.
export async function resolveOrgTimeContext(
  scopedPrisma: Pick<ExtendedPrismaClient, 'organization'>,
  organizationId: string,
): Promise<{ timezone: string; timeFormat: TimeFormatPattern }> {
  const org = await scopedPrisma.organization.findFirst({
    where: { id: organizationId },
    select: { timezone: true, policies: true },
  });
  const policies = (org?.policies ?? {}) as { timeFormat?: unknown };
  return {
    timezone: org?.timezone || 'Asia/Kolkata',
    timeFormat: isTimeFormatPattern(policies.timeFormat)
      ? policies.timeFormat
      : DEFAULT_TIME_FORMAT,
  };
}
