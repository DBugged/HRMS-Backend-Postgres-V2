// Purpose: The app-wide ValidationPipe, with validation errors worded for people instead of for developers.
// Why: class-validator's defaults read like 'noticePeriodDays must not be greater than 365, noticePeriodDays must not
//   be less than 0, noticePeriodDays must be an integer number' - the property name, and every rule it broke. This
//   shows one plain sentence per field ('Notice period days must be at most 365.').
// Important: it only rewrites the wording. What is accepted or refused (whitelist, forbidNonWhitelisted, transform)
//   is exactly what the pipe did before, and the response keeps the same shape: a 400 with `message` as a list.
import {
  BadRequestException,
  ValidationPipe,
  type ValidationError,
} from '@nestjs/common';

// 'noticePeriodDays' -> 'Notice period days'
export function fieldLabel(property: string): string {
  const words = property
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The rule's own sentence with the property name dropped ('must be an integer number'), rewritten where the stock
// wording is jargon. Anything not recognised keeps its words, with the property shown as a label.
export function friendlyMessage(property: string, raw: string): string {
  if (raw.startsWith('property ') && raw.endsWith(' should not exist')) {
    return `"${property}" is not an accepted field.`;
  }
  // A custom message written by the code (it does not start with the property name) is already for people.
  if (!raw.startsWith(property)) return raw;
  const rest = raw.slice(property.length).trim();
  const label = fieldLabel(property);
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^should not be empty$/, () => 'is required'],
    [/^must be an integer number$/, () => 'must be a whole number'],
    [/^must not be less than (.+)$/, (m) => `must be at least ${m[1]}`],
    [/^must not be greater than (.+)$/, (m) => `must be at most ${m[1]}`],
    [/^must be an email$/, () => 'must be a valid email address'],
    [/^must be a string$/, () => 'must be text'],
    [/^must be a number conforming to the specified constraints$/, () => 'must be a number with an allowed number of decimal places'],
    [/^must be a number$/, () => 'must be a number'],
    [
      /^must be shorter than or equal to (\d+) characters$/,
      (m) => `must be at most ${m[1]} characters`,
    ],
    [
      /^must be longer than or equal to (\d+) characters$/,
      (m) => `must be at least ${m[1]} characters`,
    ],
    [/^must be a boolean value$/, () => 'must be true or false'],
    [/^must be a UUID$/, () => 'is not valid'],
  ];
  for (const [pattern, build] of rules) {
    const match = rest.match(pattern);
    if (match) return `${label} ${build(match)}.`;
  }
  return `${label} ${rest}${rest.endsWith('.') ? '' : '.'}`;
}

// Which broken rule to report when a value breaks several. class-validator lists them in reverse declaration order, so the plain
// "first" was often a range rule ("must be at most 128 characters") for a field that was simply missing. Report the most basic
// problem first: missing, then wrong type, then everything else.
const PRIORITY = ['isDefined', 'isNotEmpty', 'isNotEmptyObject', 'isString', 'isNumber', 'isInt', 'isBoolean', 'isDateString', 'isArray', 'isEnum', 'isEmail', 'isUUID'];
export function pickConstraint(constraints: Record<string, string>): string {
  for (const key of PRIORITY) if (key in constraints) return constraints[key];
  return Object.values(constraints)[0];
}

function collect(errors: ValidationError[], parent = ''): string[] {
  const out: string[] = [];
  for (const error of errors) {
    const path = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) {
      // One sentence per field: the first rule it broke, not every rule.
      const first = pickConstraint(error.constraints);
      out.push(friendlyMessage(error.property, first));
    }
    if (error.children?.length) out.push(...collect(error.children, path));
  }
  return out;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new BadRequestException(collect(errors)),
  });
}
