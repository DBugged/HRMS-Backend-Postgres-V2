// A financial-year label such as "2026-27": four-digit start year, a hyphen and the last two digits of the NEXT year.
// "abc", "2026-28" or "2026" are not financial years.
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

export function isFinancialYear(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return false;
  const start = Number(m[1]);
  if (start < 2000 || start > 2100) return false;
  return Number(m[2]) === (start + 1) % 100;
}

export function IsFinancialYear(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isFinancialYear',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isFinancialYear(value),
        defaultMessage: (args?: ValidationArguments) =>
          `${args?.property} must be a financial year such as 2026-27.`,
      },
    });
  };
}
