// Purpose: Sends birthday, work-anniversary, and new-joiner-announcement wishes/emails, org-wide.
// Responsibilities: Owns the daily cron trigger (sendDailyWishes) and per-org wish logic (sendWishesForOrg);
// delegates actual delivery to NotificationsService/EmailService, and email subject/body content to
// EmailTemplatesService (falls back to the old hardcoded strings when an org has no active template for the
// occasion, so nothing breaks for orgs that predate email-templates seeding).
// Important: runs hourly and acts only for orgs whose local time is 09:00, with "today" taken in the org's own
// timezone; the month/day is then compared against joiningDate/dateOfBirth as plain calendar dates (stored
// UTC-anchored elsewhere). A same-day re-run (restart, manual run) is deduped per person and occasion by
// alreadySentToday(). The new-joiner announcement matches the *full* calendar date (not just month/day) — unlike
// a birthday or anniversary, it must fire exactly once, on the actual joining day, not every year after.
import { EMPLOYEE_ORDER_BY } from '../common/employee-order';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { companyLogoImgTag } from '../email-templates/company-logo';
import { todayInOrgTz } from '../common/org-date';

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

  // Hourly tick; each org is handled once a day, when its own local clock reads 09:00, so wishes land at a sensible
  // hour everywhere instead of at one server-time hour. A re-run on the same day (e.g. after a restart) is deduped
  // per person and occasion by alreadySentToday().
  @Cron('0 * * * *')
  async sendDailyWishes() {
    const now = new Date();
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    for (const org of organizations) {
      try {
        const localHour = Number(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: org.timezone,
            hour: '2-digit',
            hour12: false,
          }).format(now),
        );
        if (localHour !== 9) continue;
        await this.sendWishesForOrg(org.id);
      } catch (err) {
        this.logger.error(
          `Daily wishes failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async sendWishesForOrg(organizationId: string) {
    // "Today" is the org's own calendar date, held as a UTC-anchored Date so the UTC month/day helpers below compare it
    // like-for-like with joiningDate/dateOfBirth.
    const tz =
      (
        await this.scopedPrisma.organization.findFirst({
          where: { id: organizationId },
          select: { timezone: true },
        })
      )?.timezone ?? 'UTC';
    const today = new Date(`${todayInOrgTz(tz)}T00:00:00Z`);
    const todayMonthDay = monthDay(today);
    const todayIso = isoDate(today);

    const employees = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true },
      orderBy: EMPLOYEE_ORDER_BY,
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
        companyLogoUrl: true,
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
  private async alreadySentToday(
    organizationId: string,
    userId: string,
    title: string,
  ): Promise<boolean> {
    // A rolling window rather than a server-midnight cut-off: wishes go out once a day at the org's 09:00, so anything
    // sent in the last 20 hours is the same occasion, whatever timezone the server or org is in.
    const since = new Date(Date.now() - 20 * 60 * 60 * 1000);
    const count = await this.scopedPrisma.notification.count({
      where: { organizationId, userId, title, createdAt: { gte: since } },
    });
    return count > 0;
  }

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
    const hasActiveTemplate =
      await this.emailTemplatesService.findActiveByOccasion(
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
      companyLogoUrl?: string | null;
    } | null,
  ): Record<string, string> {
    return {
      companyName: organization?.companyName ?? '',
      companyPhone: organization?.phone ?? '',
      companyWebsite: organization?.website ?? '',
      companyEmail: organization?.contactEmail ?? '',
      companyAddress: organization?.registeredAddress ?? '',
      companyLogo: companyLogoImgTag(
        organizationId,
        organization?.emailLogoUrl || organization?.companyLogoUrl,
        organization?.companyName,
      ),
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
      companyLogoUrl?: string | null;
    } | null,
    activeEmails: string[],
  ) {
    const designation = employee.designation || 'a new team member';
    const title = `Welcome ${employee.name} to the team!`;
    const intro = `${employee.name} joins us today as ${designation}${
      departmentName ? ` in ${departmentName}` : ''
    } — please give them a warm welcome.`;
    // A restart or manual re-run on the same day must not wish (and e-mail, and push) the same person twice.
    if (await this.alreadySentToday(organizationId, employee.id, title)) return;
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
    // "CC all" goes as blind copies: everyone gets it, nobody sees the whole company's addresses.
    const bcc = ccAllActive
      ? activeEmails.filter((email) => email !== employee.email)
      : undefined;
    await this.emailService.send({
      organizationId,
      to: employee.email,
      subject,
      html,
      ...(bcc?.length && { bcc }),
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
      companyLogoUrl?: string | null;
    } | null,
    activeEmails: string[],
  ) {
    const title = 'Happy Birthday!';
    const message = `Happy Birthday, ${employee.name}! Wishing you a wonderful year ahead, from everyone here.`;
    // A restart or manual re-run on the same day must not wish (and e-mail, and push) the same person twice.
    if (await this.alreadySentToday(organizationId, employee.id, title)) return;
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
    // "CC all" goes as blind copies: everyone gets it, nobody sees the whole company's addresses.
    const bcc = ccAllActive
      ? activeEmails.filter((email) => email !== employee.email)
      : undefined;
    await this.emailService.send({
      organizationId,
      to: employee.email,
      subject,
      html,
      ...(bcc?.length && { bcc }),
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
      companyLogoUrl?: string | null;
    } | null,
    activeEmails: string[],
  ) {
    const title = `Happy Work Anniversary!`;
    const message = `Congratulations on your ${years}${ORDINAL_SUFFIX(years)} work anniversary, ${employee.name}! Thank you for everything you've contributed.`;
    // A restart or manual re-run on the same day must not wish (and e-mail, and push) the same person twice.
    if (await this.alreadySentToday(organizationId, employee.id, title)) return;
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
    // "CC all" goes as blind copies: everyone gets it, nobody sees the whole company's addresses.
    const bcc = ccAllActive
      ? activeEmails.filter((email) => email !== employee.email)
      : undefined;
    await this.emailService.send({
      organizationId,
      to: employee.email,
      subject,
      html,
      ...(bcc?.length && { bcc }),
    });
  }
}
