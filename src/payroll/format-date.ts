/**
 * Pure port of the old backend's utils/formatDate.js — human-facing date
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

function isDateFormatPattern(v: unknown): v is DateFormatPattern {
  return v === 'DD-MM-YYYY' || v === 'MM-DD-YYYY' || v === 'YYYY-MM-DD';
}
function isTimeFormatPattern(v: unknown): v is TimeFormatPattern {
  return v === '12' || v === '24';
}

// Formats any date-like value (YYYY-MM-DD string, ISO datetime string, or
// Date) per `dateFormat` (org-configurable, defaults to DD-MM-YYYY).
export function formatDateDisplay(
  value: unknown,
  fallback = '',
  dateFormat: DateFormatPattern = DEFAULT_DATE_FORMAT,
): string {
  const d = toDateObject(value);
  if (!d) return fallback;
  const dd = pad2(d.getDate());
  const mm = pad2(d.getMonth() + 1);
  const yyyy = String(d.getFullYear());
  switch (dateFormat) {
    case 'MM-DD-YYYY':
      return `${mm}-${dd}-${yyyy}`;
    case 'YYYY-MM-DD':
      return `${yyyy}-${mm}-${dd}`;
    default:
      return `${dd}-${mm}-${yyyy}`;
  }
}

// Same as formatDateDisplay but also appends the time, per `timeFormat`
// (org-configurable, defaults to 12-hour).
export function formatDateTimeDisplay(
  value: unknown,
  fallback = '',
  dateFormat: DateFormatPattern = DEFAULT_DATE_FORMAT,
  timeFormat: TimeFormatPattern = DEFAULT_TIME_FORMAT,
): string {
  const d = toDateObject(value);
  if (!d) return fallback;
  const minutes = pad2(d.getMinutes());
  const datePart = formatDateDisplay(d, fallback, dateFormat);
  if (timeFormat === '24') {
    return `${datePart}, ${pad2(d.getHours())}:${minutes}`;
  }
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${datePart}, ${pad2(hours)}:${minutes} ${ampm}`;
}

export interface OrgDateTimeFormat {
  dateFormat: DateFormatPattern;
  timeFormat: TimeFormatPattern;
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
    select: { policies: true },
  });
  const policies = (org?.policies ?? {}) as {
    dateFormat?: unknown;
    timeFormat?: unknown;
  };
  return {
    dateFormat: isDateFormatPattern(policies.dateFormat)
      ? policies.dateFormat
      : DEFAULT_DATE_FORMAT,
    timeFormat: isTimeFormatPattern(policies.timeFormat)
      ? policies.timeFormat
      : DEFAULT_TIME_FORMAT,
  };
}
