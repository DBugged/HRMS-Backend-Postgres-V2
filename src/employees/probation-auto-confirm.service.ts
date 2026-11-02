// Purpose: confirms people automatically when their probation end date arrives, for companies that turned it on.
// Responsibilities: every day at 09:50, for each organisation with "Confirm probation automatically" on (policies.autoConfirmProbation),
//   confirms every active employee still on probation (PROBATION / EXTENDED_PROBATION, no exit set) whose probation end date is
//   today or earlier, through the same path HR uses (EmployeeProfileService.probationDecision) - so the status history, timeline,
//   employee-type change, confirmation letter and email all happen exactly as for a manual confirmation.
// Important: OFF by default - confirming is a decision, so a company opts in. HR still extends probation by hand before the end
//   date; the existing 15- and 7-day reminders give them time to. The decision is recorded under the company's first active Admin
//   with the note "Confirmed automatically", and a failure on one person never stops the others.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { EmployeeProfileService } from './employee-profile.service';

/** Whether a company has switched automatic probation confirmation on (off unless it is exactly true). */
export function readAutoConfirmProbation(policies: unknown): boolean {
  return (policies as { autoConfirmProbation?: unknown } | null)?.autoConfirmProbation === true;
}

@Injectable()
export class ProbationAutoConfirmService {
  private readonly logger = new Logger(ProbationAutoConfirmService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly employeeProfile: EmployeeProfileService,
  ) {}

  @Cron('50 9 * * *')
  async daily() {
    const orgs = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true, policies: true },
    });
    for (const org of orgs) {
      if (!readAutoConfirmProbation(org.policies)) continue;
      try {
        await this.confirmDueForOrg(org.id, todayInOrgTz(org.timezone));
      } catch (err) {
        this.logger.error(`Automatic probation confirmation failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  // Returns how many people were confirmed.
  async confirmDueForOrg(organizationId: string, today: string): Promise<number> {
    const due = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        exitDate: null,
        employmentStatus: { in: ['PROBATION', 'EXTENDED_PROBATION'] },
        probationEndDate: { not: null, lte: today },
      },
      select: { id: true, probationEndDate: true },
    });
    if (due.length === 0) return 0;
    const actor = await this.scopedPrisma.user.findFirst({
      where: { organizationId, isActive: true, role: Role.ADMIN },
      orderBy: { createdAt: 'asc' },
    });
    if (!actor) return 0;
    let confirmed = 0;
    for (const person of due) {
      try {
        await this.employeeProfile.probationDecision(
          person.id,
          { decision: 'confirmed', effectiveDate: person.probationEndDate as string, note: 'Confirmed automatically on the probation end date.' } as never,
          actor as never,
          organizationId,
        );
        confirmed += 1;
      } catch (err) {
        this.logger.warn(`Could not confirm ${person.id} automatically: ${(err as Error).message}`);
      }
    }
    return confirmed;
  }
}
