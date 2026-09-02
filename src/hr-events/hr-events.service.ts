// Purpose: Sends birthday, work-anniversary, and new-joiner-announcement wishes/emails, org-wide.
// Responsibilities: Owns the daily cron trigger (sendDailyWishes) and per-org wish logic (sendWishesForOrg);
// delegates actual delivery to NotificationsService/EmailService, and email subject/body content to
// EmailTemplatesService (falls back to the old hardcoded strings when an org has no active template for the
// occasion, so nothing breaks for orgs that predate email-templates seeding).
// Important: matches month/day in UTC to stay consistent with how joiningDate/dateOfBirth are stored
// elsewhere, and is not deduped against a same-day re-run (e.g. after a restart) — wishes simply resend,
// same accepted precedent as the Marked Absent email in AttendanceService. The new-joiner announcement is
// the one exception that matches the *full* calendar date (not just month/day) — unlike a birthday or
// anniversary, it must fire exactly once, on the actual joining day, not every year after.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { companyLogoImgTag } from '../email-templates/company-logo';

// joiningDate/dateOfBirth are entered as plain calendar dates (no
// meaningful time-of-day) and stored/read as UTC-anchored values
// elsewhere in this codebase (see localDateStr) — comparing via UTC
// month/day, rather than a per-organization-timezone conversion, keeps
// this consistent with how those dates were written in the first place.
function monthDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// Full calendar date (UTC), for the new-joiner announcement's exactly-once
// match — monthDay() alone would also match on every later anniversary.
function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

const ORDINAL_SUFFIX = (n: number): string => {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
};

@Injectable()
export class HrEventsService {
  private readonly logger = new Logger(HrEventsService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  // Once a day is enough granularity for a calendar-date match. Not
  // deduped against a re-run mid-day (e.g. after a restart) — same
  // accepted precedent as the existing Marked Absent email, which also
  // resends every run rather than tracking "already sent today".
  @Cron('0 8 * * *')
  async sendDailyWishes() {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    for (const org of organizations) {
      await this.sendWishesForOrg(org.id);
    }
  }

  async sendWishesForOrg(organizationId: string) {
    const today = new Date();
    const todayMonthDay = monthDay(today);
    const todayIso = isoDate(today);

    const employees = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        name: true,
        email: true,
        joiningDate: true,
        personalData: true,
        designation: true,
        departmentId: true,
      },
    });

    // Fetched once per org run (not once per matching employee) — the cc
    // list and org variables are identical for every wish sent this run.
    const activeEmails = employees.map((e) => e.email);
    const organization = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: {
        companyName: true,
        phone: true,
        website: true,
        contactEmail: true,
        registeredAddress: true,
        emailLogoUrl: true,
      },
    });
    const departments = await this.scopedPrisma.department.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    });
    const departmentNameById = new Map(departments.map((d) => [d.id, d.name]));

    for (const employee of employees) {
      if (isoDate(employee.joiningDate) === todayIso) {
        await this.sendNewJoinerAnnouncement(
          organizationId,
          employee,
          departmentNameById.get(employee.departmentId ?? '') ?? null,
          organization,
          activeEmails,
        );
      }
      const personalData = (employee.personalData ?? {}) as Record<
        string,
        unknown
      >;
      const dob =
        typeof personalData.dateOfBirth === 'string'
          ? personalData.dateOfBirth
          : null;
      if (dob && dob.length >= 10 && dob.slice(5, 10) === todayMonthDay) {
        await this.sendBirthdayWish(
          organizationId,
          employee,
          organization,
          activeEmails,
        );
      }

      if (monthDay(employee.joiningDate) === todayMonthDay) {
        const years =
          today.getUTCFullYear() - employee.joiningDate.getUTCFullYear();
        if (years >= 1) {
          await this.sendAnniversaryWish(
            organizationId,
            employee,
            years,
            organization,
            activeEmails,
          );
        }
      }
    }
  }

  // Renders the org's active email template for `occasionKey`, falling
  // back to the hardcoded subject/html when none is active (an org
  // predating email-templates seeding, or one that's disabled the
  // template) — so a missing/disabled template degrades gracefully rather
  // than silently dropping the wish email.
  private async renderOccasionEmail(
    organizationId: string,
    occasionKey: string,
    variables: Record<string, string>,
    fallback: { subject: string; html: string },
  ): Promise<{ subject: string; html: string; ccAllActive: boolean }> {
    // Delegates to EmailTemplatesService.renderOccasion for the actual
    // template lookup/render/signature-append (it also appends the org's
    // shared email signature — see that method) — this wrapper exists only
    // to keep this file's ccAllActive fallback (true — Birthday/Anniversary
    // default to CC'ing everyone) distinct from renderOccasion's own
    // fallback default (false), which fits the other 22 occasions better.
    const rendered = await this.emailTemplatesService.renderOccasion(
      organizationId,
      occasionKey,
      variables,
      fallback,
    );
    const hasActiveTemplate = await this.emailTemplatesService.findActiveByOccasion(
      occasionKey,
      organizationId,
    );
    return {
      ...rendered,
      ccAllActive: hasActiveTemplate ? rendered.ccAllActive : true,
    };
  }

  private orgVariables(
    organizationId: string,
    organization: {
      companyName: string | null;
      phone: string | null;
      website: string | null;
      contactEmail: string | null;
      registeredAddress: string | null;
      emailLogoUrl: string | null;
    } | null,
  ): Record<string, string> {
    return {
      companyName: organization?.companyName ?? '',
      companyPhone: organization?.phone ?? '',
      companyWebsite: organization?.website ?? '',
      companyEmail: organization?.contactEmail ?? '',
      companyAddress: organization?.registeredAddress ?? '',
      companyLogo: companyLogoImgTag(organizationId, organization?.emailLogoUrl),
    };
  }

  private async sendNewJoinerAnnouncement(
    organizationId: string,
    employee: {
      id: string;
      name: string;
      email: string;
      designation: string;
    },
    departmentName: string | null,
    organization: {
      companyName: string | null;
      phone: string | null;
      website: string | null;
      contactEmail: string | null;
      registeredAddress: string | null;
      emailLogoUrl: string | null;
    } | null,
    activeEmails: string[],
  ) {
    const designation = employee.designation || 'a new team member';
    const title = `Welcome ${employee.name} to the team!`;
    const intro = `${employee.name} joins us today as ${designation}${
      departmentName ? ` in ${departmentName}` : ''
    } — please give them a warm welcome.`;
    await this.notificationsService.create({
      organizationId,
      userId: employee.id,
      title,
      message: intro,
      category: NotificationCategory.GENERAL,
    });

    const variables = {
      employeeName: employee.name,
      designation,
      departmentLine: departmentName ? ` in ${departmentName}` : '',
      intro,
      ...this.orgVariables(organizationId, organization),
    };
    const { subject, html, ccAllActive } = await this.renderOccasionEmail(
      organizationId,
      'NEW_JOINER_ANNOUNCEMENT',
      variables,
      { subject: title, html: `<p>${intro}</p>` },
    );
    // The whole company, not just the new joiner, is the audience here —
    // ccAllActive defaults to true for this occasion (see the
    // NEW_JOINER_ANNOUNCEMENT default), same "to: employee, cc: everyone
    // else active" delivery shape as Birthday/Anniversary.
    const cc = ccAllActive
      ? activeEmails.filter((email) => email !== employee.email)
      : undefined;
    await this.emailService.send({
      to: employee.email,
      subject,
      html,
      ...(cc?.length && { cc }),
    });
  }

  private async sendBirthdayWish(
    organizationId: string,
    employee: { id: string; name: string; email: string },
    organization: {
      companyName: string | null;
      phone: string | null;
      website: string | null;
      contactEmail: string | null;
      registeredAddress: string | null;
      emailLogoUrl: string | null;
    } | null,
    activeEmails: string[],
  ) {
    const title = 'Happy Birthday!';
    const message = `Happy Birthday, ${employee.name}! Wishing you a wonderful year ahead, from everyone here.`;
    await this.notificationsService.create({
      organizationId,
      userId: employee.id,
      title,
      message,
      category: NotificationCategory.GENERAL,
    });

    const variables = {
      employeeName: employee.name,
      ...this.orgVariables(organizationId, organization),
    };
    const { subject, html, ccAllActive } = await this.renderOccasionEmail(
      organizationId,
      'BIRTHDAY',
      variables,
      { subject: title, html: `<p>${message}</p>` },
    );
    const cc = ccAllActive
      ? activeEmails.filter((email) => email !== employee.email)
      : undefined;
    await this.emailService.send({
      to: employee.email,
      subject,
      html,
      ...(cc?.length && { cc }),
    });
  }

  private async sendAnniversaryWish(
    organizationId: string,
    employee: { id: string; name: string; email: string },
    years: number,
    organization: {
      companyName: string | null;
      phone: string | null;
      website: string | null;
      contactEmail: string | null;
      registeredAddress: string | null;
      emailLogoUrl: string | null;
    } | null,
    activeEmails: string[],
  ) {
    const title = `Happy Work Anniversary!`;
    const message = `Congratulations on your ${years}${ORDINAL_SUFFIX(years)} work anniversary, ${employee.name}! Thank you for everything you've contributed.`;
    await this.notificationsService.create({
      organizationId,
      userId: employee.id,
      title,
      message,
      category: NotificationCategory.GENERAL,
    });

    const variables = {
      employeeName: employee.name,
      years: `${years}${ORDINAL_SUFFIX(years)}`,
      ...this.orgVariables(organizationId, organization),
    };
    const { subject, html, ccAllActive } = await this.renderOccasionEmail(
      organizationId,
      'WORK_ANNIVERSARY',
      variables,
      { subject: title, html: `<p>${message}</p>` },
    );
    const cc = ccAllActive
      ? activeEmails.filter((email) => email !== employee.email)
      : undefined;
    await this.emailService.send({
      to: employee.email,
      subject,
      html,
      ...(cc?.length && { cc }),
    });
  }
}
