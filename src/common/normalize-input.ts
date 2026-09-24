// Purpose: class-transformer decorators that normalize free-text DTO input before class-validator runs.
// Responsibilities: NormalizeEmail — trim + lowercase, so `A@X.test` and `a@x.test` are one account
//   (User.email also has a unique index on lower(email)) and mixed-case login works; Trim — strip
//   surrounding whitespace so a whitespace-only required name fails @IsNotEmpty instead of being stored.
// Important: Only strings are touched; any other type passes through for the validators to reject.
import { Transform } from 'class-transformer';

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function NormalizeEmail(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  );
}

export function Trim(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}
