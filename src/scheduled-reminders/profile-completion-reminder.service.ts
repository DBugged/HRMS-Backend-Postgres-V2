// Purpose: the weekly nudge about incomplete profiles - to each employee for their own, to each manager for their team, and a
//   headline to HR/Admin.
// Responsibilities: every Monday 10:00, scores every active employee with the same rules as the profile completeness card
//   (profile-score.ts: personal fields, bank, PAN, Aadhaar, cheque, photo, job details, UAN where PF applies, mandatory documents),
//   then notifies. Uses the in-app notice and push; the missing-documents job already sends its own email.
// Important: nothing is sent to someone at 100%; the notifier skips a person reminded in the last 6 days, so a restart or a manual
//   run never nags twice.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EmployeeDocumentCategory, NotificationCategory, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { profileScore, withAccountFields, withRootGender } from '../employees/profile-score';
import { uanRequiredFor } from '../employees/personal-data';
import { ReminderNotifier } from './reminder-notifier.service';

const SIX_DAYS = 24 * 6;

@Injectable()
export class ProfileCompletionReminderService {
  private readonly logger = new Logger(ProfileCompletionReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  @Cron('0 10 * * 1')
  async sendWeeklyReminders() {
    const orgs = await this.scopedPrisma.organization.findMany({ where: { isActive: true }, select: { id: true } });
    for (const org of orgs) {
      try {
        await this.remindForOrg(org.id);
      } catch (err) {
        this.logger.error(`Profile reminders failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  async remindForOrg(organizationId: string): Promise<number> {
    const p = this.scopedPrisma;
    const [users, requirements, documents, settings, people] = await Promise.all([
      this.notifier.activeUsers(organizationId),
      p.documentRequirement.findMany({ where: { organizationId, isMandatory: true, isActive: true }, select: { name: true, isMandatory: true, isActive: true } }),
      p.employeeDocument.findMany({ where: { organizationId, category: EmployeeDocumentCategory.DOCUMENT }, select: { employeeId: true, docType: true, status: true } }),
      p.payrollSettings.findFirst({ where: { organizationId }, select: { pfEnabled: true } }),
      p.user.findMany({
        where: { organizationId, isActive: true, exitDate: null },
        select: { id: true, gender: true, personalData: true, employeeType: true, contactNumber: true, profileImage: true, designation: true, departmentId: true, employeeCategory: true, workLocationId: true },
      }),
    ]);
    const docsBy = new Map<string, { docType: string; status: string }[]>();
    for (const d of documents) docsBy.set(d.employeeId, [...(docsBy.get(d.employeeId) ?? []), d]);
    const scoreOf = new Map<string, ReturnType<typeof profileScore>>();
    for (const e of people) {
      scoreOf.set(
        e.id,
        profileScore(
          withAccountFields(withRootGender(e.personalData as Record<string, unknown>, e.gender), e),
          requirements,
          docsBy.get(e.id) ?? [],
          { uanRequired: uanRequiredFor({ pfEnabled: settings?.pfEnabled ?? false, employeeType: e.employeeType }) },
        ),
      );
    }

    let sent = 0;
    const byManager = new Map<string, string[]>();
    let incomplete = 0;
    for (const user of users) {
      const score = scoreOf.get(user.id);
      if (!score || score.percent >= 100) continue;
      incomplete++;
      const preview = score.missing.slice(0, 3).map((m) => m.label).join(', ');
      if (await this.notifier.send({
        organizationId, user, occasionKey: 'PROFILE_REMINDER', variables: {}, inAppOnly: true, dedupeWithinHours: SIX_DAYS,
        title: 'Complete your profile',
        message: `Your profile is ${score.percent}% complete. Still missing: ${preview}${score.missing.length > 3 ? ` and ${score.missing.length - 3} more` : ''}.`,
        category: NotificationCategory.GENERAL,
      })) sent++;
      for (const managerId of [user.reportingManagerId, ...(user.additionalReportingManagerIds ?? [])]) {
        if (managerId) byManager.set(managerId, [...(byManager.get(managerId) ?? []), user.name]);
      }
    }
    for (const user of users) {
      const team = byManager.get(user.id);
      if (!team?.length) continue;
      if (await this.notifier.send({
        organizationId, user, occasionKey: 'PROFILE_REMINDER', variables: {}, inAppOnly: true, dedupeWithinHours: SIX_DAYS,
        title: 'Team profiles incomplete',
        message: `${team.length} ${team.length === 1 ? 'person' : 'people'} in your team ${team.length === 1 ? 'has' : 'have'} an incomplete profile: ${team.slice(0, 4).join(', ')}${team.length > 4 ? ` and ${team.length - 4} more` : ''}.`,
        category: NotificationCategory.GENERAL,
      })) sent++;
    }
    if (incomplete > 0) {
      for (const hr of users.filter((u) => u.role === Role.HR || u.role === Role.ADMIN)) {
        if (await this.notifier.send({
          organizationId, user: hr, occasionKey: 'PROFILE_REMINDER', variables: {}, inAppOnly: true, dedupeWithinHours: SIX_DAYS,
          title: 'Profiles below 100%',
          message: `${incomplete} employee${incomplete === 1 ? ' has' : 's have'} an incomplete profile. Open Employees, filter by Completeness and send a reminder.`,
          category: NotificationCategory.GENERAL,
        })) sent++;
      }
    }
    return sent;
  }
}
