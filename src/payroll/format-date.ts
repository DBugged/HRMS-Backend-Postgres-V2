/**
 * Pure port of the old backend's utils/formatDate.js — human-facing date
 * text for generated documents (payslip PDFs, reports). Stored values
 * (DB columns, API JSON) are untouched; this only formats text meant to
 * be read.
 */

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

// Formats any date-like value (YYYY-MM-DD string, ISO datetime string, or
// Date) as DD-MM-YYYY.
export function formatDateDisplay(value: unknown, fallback = ''): string {
  const d = toDateObject(value);
  if (!d) return fallback;
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
}

// Same as formatDateDisplay but also appends the time (12-hour clock).
export function formatDateTimeDisplay(value: unknown, fallback = ''): string {
  const d = toDateObject(value);
  if (!d) return fallback;
  let hours = d.getHours();
  const minutes = pad2(d.getMinutes());
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${formatDateDisplay(d)}, ${pad2(hours)}:${minutes} ${ampm}`;
}
