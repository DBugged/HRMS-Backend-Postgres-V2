// Purpose: The one rule every phone/contact number field in the app follows - an Indian mobile number.
// A number is 10 digits and starts with 6, 7, 8 or 9 (never 0), optionally written with the +91 country code
// ("9876543210", "+91 98765 43210", "+91-9876543210"). The frontend PhoneInput and the mobile app's PhoneField
// enforce the same rule, so a value is accepted or rejected identically on every layer.
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const MOBILE = /^(?:\+91)?[6-9][0-9]{9}$/;

export function isValidIndianMobile(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return MOBILE.test(value.replace(/[\s()-]/g, ''));
}

// Optional-field variant: blank is "not filled in" and passes; anything else must be a valid mobile number.
export function IsIndianMobile(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isIndianMobile',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) =>
          value === undefined ||
          value === null ||
          (typeof value === 'string' &&
            (value.trim() === '' || isValidIndianMobile(value))),
        defaultMessage: (args?: ValidationArguments) =>
          `${args?.property} must be a 10-digit mobile number starting with 6, 7, 8 or 9 (optionally with +91).`,
      },
    });
  };
}
