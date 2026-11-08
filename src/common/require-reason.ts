// Purpose: one rule for decisions that turn something down: a reason must be given, and the person it affects sees it.
// Usage: requireReason(dto.comments, 'rejecting a comp-off request') at the top of a review method, only on the reject path.
import { BadRequestException } from '@nestjs/common';

export function requireReason(text: string | null | undefined, what: string): string {
  const value = (text ?? '').trim();
  if (!value) throw new BadRequestException(`Add a reason for ${what}.`);
  return value;
}
