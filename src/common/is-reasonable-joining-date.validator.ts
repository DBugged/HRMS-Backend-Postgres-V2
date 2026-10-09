// A joining date has to be a real calendar date that is plausible for a hire: not before 1990 and not more than
// 180 days ahead (an upcoming joiner is fine, a joining date in 2099 is a typo).
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { isValidCalendarDateString } from './is-valid-calendar-date.validator';

export const EARLIEST_JOINING_DATE = '1990-01-01';
export const MAX_JOINING_DAYS_AHEAD = 180;

export function isReasonableJoiningDate(
  value: unknown,
  now: Date = new Date(),
): boolean {
  if (!isValidCalendarDateString(value)) return false;
  const latest = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  latest.setUTCDate(latest.getUTCDate() + MAX_JOINING_DAYS_AHEAD);
  const text = value as string;
  return (
    text >= EARLIEST_JOINING_DATE && text <= latest.toISOString().slice(0, 10)
  );
}

export function IsReasonableJoiningDate(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isReasonableJoiningDate',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isReasonableJoiningDate(value),
        defaultMessage: (args?: ValidationArguments) =>
          `${args?.property} must be a real date between ${EARLIEST_JOINING_DATE} and ${MAX_JOINING_DAYS_AHEAD} days from today.`,
      },
    });
  };
}
