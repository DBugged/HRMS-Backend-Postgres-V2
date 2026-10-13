// Purpose: sanity bounds for a punch time supplied by an external device or gateway.
// Responsibilities: reject a time in the future or older than the longest a device could plausibly have held it.
// Important: the face-API webhook is authenticated only by a shared key, so the punch time it supplies is the
//   caller's word. These bounds limit what a leaked key or a replayed old request can write (the payroll-period lock and
//   the duplicate-punch window still apply on top).
import { BadRequestException } from '@nestjs/common';

export const MAX_PUNCH_FUTURE_MS = 5 * 60 * 1000;
// A gateway that was offline can sync a backlog, but not a month-old one.
export const MAX_PUNCH_AGE_MS = 45 * 24 * 60 * 60 * 1000;

export function assertPunchTimeSane(punchTime: Date, now: Date = new Date()) {
  if (Number.isNaN(punchTime.getTime())) {
    throw new BadRequestException('punchTime is not a valid date.');
  }
  if (punchTime.getTime() > now.getTime() + MAX_PUNCH_FUTURE_MS) {
    throw new BadRequestException('punchTime cannot be in the future.');
  }
  if (punchTime.getTime() < now.getTime() - MAX_PUNCH_AGE_MS) {
    throw new BadRequestException(
      'punchTime is too old to be accepted from a device.',
    );
  }
}
