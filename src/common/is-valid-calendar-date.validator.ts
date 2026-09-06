// Purpose: A real calendar-aware YYYY-MM-DD date validator, for every plain-string date DTO field in the
// app (leave/comp-off/reimbursement/employee/salary-component dates, etc).
// Responsibilities: Catches two distinct classes of bad input that a plain `@Matches(/^\d{4}-\d{2}-\d{2}$/)`
// or `@IsDateString()` both let through: (1) a syntactically-shaped but impossible date like "2026-02-30"
// — JS's Date constructor silently rolls this forward to 2026-03-02 instead of throwing, so a regex/
// IsDateString check alone accepts it and the wrong date gets persisted; (2) an implausible year like
// "0000-01-01", which is a valid calendar date but not a usable one for any real HR record, and can crash
// downstream Date/Prisma handling with an unhandled 500 instead of a clean 400.
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Generous, not a business-rule cutoff — just wide enough to reject
// obviously-wrong years (0000, 9999) while never rejecting a real
// birthdate, joining date, or leave/payroll date any org would use.
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

export function isValidCalendarDateString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  // Round-tripping the parsed components back through the UTC getters is
  // the only way to catch an out-of-range month/day that Date silently
  // normalized (e.g. month 13, or Feb 30) instead of throwing.
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function IsValidCalendarDateString(
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidCalendarDateString',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isValidCalendarDateString(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid calendar date in YYYY-MM-DD format`;
        },
      },
    });
  };
}
