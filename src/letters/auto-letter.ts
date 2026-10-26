// Purpose: sends a standard letter (resignation acceptance, confirmation, probation extension) as a side effect of an HR
//   decision, so HR no longer has to remember to generate and send it.
// Important: best-effort. The decision it follows has already been saved and must never fail because the letter could not be
//   sent (no active template for the company, no email address on file, mail down) - the reason is logged and HR can still
//   send the letter by hand from the employee's Letters tab. Returns whether it was sent.
import type { Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { LettersService } from './letters.service';

export async function sendLetterQuietly(
  letters: LettersService,
  logger: Logger,
  employeeId: string,
  key: 'resignationAcceptance' | 'confirmationLetter' | 'probationExtensionLetter',
  actor: Omit<User, 'password'>,
  organizationId: string,
): Promise<boolean> {
  try {
    await letters.send(employeeId, key, actor, organizationId);
    return true;
  } catch (err) {
    logger.warn(`Automatic ${key} for ${employeeId} not sent: ${(err as Error).message}`);
    return false;
  }
}
