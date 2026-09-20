import { registerDecorator, ValidationOptions } from 'class-validator';

// Intl.supportedValuesOf('timeZone') lists only canonical IDs (e.g. Asia/Calcutta, not the
// widely used Asia/Kolkata), so validate by constructing a formatter instead. The shape check
// rejects offsets like "+05:30" / bare abbreviations that newer Node versions also accept.
export function isIanaTimeZone(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value !== 'UTC' && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(value))
    return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function IsIanaTimeZone(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isIanaTimeZone',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a valid IANA timezone (e.g. Asia/Kolkata)`,
        ...options,
      },
      validator: { validate: isIanaTimeZone },
    });
}
