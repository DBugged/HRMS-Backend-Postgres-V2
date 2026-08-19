import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';

// joiningDate/dateOfBirth are entered as plain calendar dates (no
// meaningful time-of-day) and stored/read as UTC-anchored values
// elsewhere in this codebase (see localDateStr) — comparing via UTC
// month/day, rather than a per-organization-timezone conversion, keeps
// this consistent with how those dates were written in the first place.
function monthDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
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

    const employees = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        name: true,
        email: true,
        joiningDate: true,
        personalData: true,
      },
    });

    for (const employee of employees) {
      const personalData = (employee.personalData ?? {}) as Record<
        string,
        unknown
      >;
      const dob =
        typeof personalData.dateOfBirth === 'string'
          ? personalData.dateOfBirth
          : null;
      if (dob && dob.length >= 10 && dob.slice(5, 10) === todayMonthDay) {
        await this.sendBirthdayWish(organizationId, employee);
      }

      if (monthDay(employee.joiningDate) === todayMonthDay) {
        const years =
          today.getUTCFullYear() - employee.joiningDate.getUTCFullYear();
        if (years >= 1) {
          await this.sendAnniversaryWish(organizationId, employee, years);
        }
      }
    }
  }

  private async sendBirthdayWish(
    organizationId: string,
    employee: { id: string; name: string; email: string },
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
    await this.emailService.send({
      to: employee.email,
      subject: title,
      html: `<p>${message}</p>`,
    });
  }

  private async sendAnniversaryWish(
    organizationId: string,
    employee: { id: string; name: string; email: string },
    years: number,
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
    await this.emailService.send({
      to: employee.email,
      subject: title,
      html: `<p>${message}</p>`,
    });
  }
}
