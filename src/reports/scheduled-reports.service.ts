// Purpose: reports emailed on a schedule - the Admin/HR picks a report, how often, and who gets it.
// Responsibilities: CRUD for ScheduledReport, and the hourly job that builds each due report (with the same exporters
//   and branding as a download) and emails it as an attachment; records the outcome on the schedule.
// Important: a run uses its creator's access (Admin/HR) and stops, saying why, once they are no longer an active
//   Admin/HR; each schedule runs at most once per organization-calendar day, and one failing schedule never stops the
//   others. Only table reports from the catalog can be scheduled.
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AuditModule, Role, User } from '@prisma/client';
import type { Response } from 'express';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { EmailService } from '../notifications/email.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { todayInOrgTz } from '../common/org-date';
import { ReportsService } from './reports.service';
import { OpsReportsService } from './ops-reports.service';
import { sendReportBranded } from './report-branding';
import { CapturedResponse } from './captured-response';
import { SCHEDULED_REPORTS } from './scheduled-report-catalog';
import {
  isScheduleDue,
  periodFor,
  type ScheduleFrequency,
} from './scheduled-report-period';
import type { ReportFormat } from './report-export';
import {
  CreateScheduledReportDto,
  UpdateScheduledReportDto,
} from './dto/scheduled-report.dto';

type Actor = Omit<User, 'password'>;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The organization's current hour (0-23) and weekday (0 = Sunday), from its own timezone.
function orgClock(timezone: string, instant = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(instant),
  );
  const today = todayInOrgTz(timezone, instant);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return { today, hour, weekday };
}

@Injectable()
export class ScheduledReportsService {
  private readonly logger = new Logger(ScheduledReportsService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly reports: ReportsService,
    private readonly ops: OpsReportsService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
  ) {}

  options() {
    return Object.entries(SCHEDULED_REPORTS).map(([key, r]) => ({
      key,
      label: r.label,
      covers: r.covers,
    }));
  }

  list(organizationId: string) {
    return this.scopedPrisma.scheduledReport.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async validate(
    d: {
      reportKey?: string;
      frequency?: string;
      dayOfWeek?: number | null;
      dayOfMonth?: number | null;
      departmentId?: string | null;
    },
    organizationId: string,
  ) {
    if (d.reportKey !== undefined && !SCHEDULED_REPORTS[d.reportKey]) {
      throw new BadRequestException('That report cannot be scheduled.');
    }
    if (d.frequency === 'WEEKLY' && (d.dayOfWeek ?? null) === null) {
      throw new BadRequestException('Choose the day of the week.');
    }
    if (d.frequency === 'MONTHLY' && (d.dayOfMonth ?? null) === null) {
      throw new BadRequestException('Choose the day of the month (1-28).');
    }
    if (d.departmentId) {
      const dept = await this.scopedPrisma.department.findFirst({
        where: { id: d.departmentId, organizationId },
        select: { id: true },
      });
      if (!dept) throw new BadRequestException('Unknown department.');
    }
  }

  private cleanRecipients(list: string[]) {
    return [...new Set(list.map((e) => e.trim().toLowerCase()))];
  }

  async create(
    dto: CreateScheduledReportDto,
    actor: Actor,
    organizationId: string,
  ) {
    await this.validate(dto, organizationId);
    const row = await this.scopedPrisma.scheduledReport.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        reportKey: dto.reportKey,
        format: dto.format ?? 'xlsx',
        frequency: dto.frequency,
        dayOfWeek: dto.frequency === 'WEEKLY' ? (dto.dayOfWeek ?? null) : null,
        dayOfMonth:
          dto.frequency === 'MONTHLY' ? (dto.dayOfMonth ?? null) : null,
        sendHour: dto.sendHour ?? 8,
        recipients: this.cleanRecipients(dto.recipients),
        departmentId: dto.departmentId ?? null,
        enabled: dto.enabled ?? true,
        createdById: actor.id,
      },
    });
    await this.audit(actor, 'SCHEDULED_REPORT_CREATED', row.id, {
      reportKey: row.reportKey,
      frequency: row.frequency,
      recipients: row.recipients.length,
    });
    return row;
  }

  private async findOr404(id: string, organizationId: string) {
    const row = await this.scopedPrisma.scheduledReport.findFirst({
      where: { id, organizationId },
    });
    if (!row) throw new NotFoundException('Scheduled report not found.');
    return row;
  }

  async update(
    id: string,
    dto: UpdateScheduledReportDto,
    actor: Actor,
    organizationId: string,
  ) {
    const existing = await this.findOr404(id, organizationId);
    const frequency = dto.frequency ?? existing.frequency;
    await this.validate(
      {
        reportKey: dto.reportKey,
        frequency,
        dayOfWeek: dto.dayOfWeek ?? existing.dayOfWeek,
        dayOfMonth: dto.dayOfMonth ?? existing.dayOfMonth,
        departmentId: dto.departmentId,
      },
      organizationId,
    );
    await this.scopedPrisma.scheduledReport.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.reportKey !== undefined && { reportKey: dto.reportKey }),
        ...(dto.format !== undefined && { format: dto.format }),
        frequency,
        dayOfWeek:
          frequency === 'WEEKLY' ? (dto.dayOfWeek ?? existing.dayOfWeek) : null,
        dayOfMonth:
          frequency === 'MONTHLY'
            ? (dto.dayOfMonth ?? existing.dayOfMonth)
            : null,
        ...(dto.sendHour !== undefined && { sendHour: dto.sendHour }),
        ...(dto.recipients !== undefined && {
          recipients: this.cleanRecipients(dto.recipients),
        }),
        ...(dto.departmentId !== undefined && {
          departmentId: dto.departmentId,
        }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
      },
    });
    await this.audit(actor, 'SCHEDULED_REPORT_UPDATED', id, {});
    return this.findOr404(id, organizationId);
  }

  async remove(id: string, actor: Actor, organizationId: string) {
    await this.findOr404(id, organizationId);
    await this.scopedPrisma.scheduledReport.deleteMany({
      where: { id, organizationId },
    });
    await this.audit(actor, 'SCHEDULED_REPORT_DELETED', id, {});
    return { deleted: true };
  }

  // "Send now": runs it immediately for the caller (a test of the schedule); does not count as today's scheduled run.
  async runNow(id: string, actor: Actor, organizationId: string) {
    const row = await this.findOr404(id, organizationId);
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const result = await this.execute(row, today, false);
    await this.audit(actor, 'SCHEDULED_REPORT_SENT_NOW', id, {
      status: result.status,
    });
    return result;
  }

  // Hourly, on the hour: every enabled schedule that is due in its organization's own day / hour.
  @Cron('0 * * * *')
  async runDue(): Promise<number> {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    let sent = 0;
    for (const org of organizations) {
      try {
        const now = orgClock(org.timezone);
        const schedules = await this.scopedPrisma.scheduledReport.findMany({
          where: { organizationId: org.id, enabled: true },
        });
        for (const s of schedules) {
          if (!isScheduleDue(s, now)) continue;
          const result = await this.execute(s, now.today, true);
          if (result.status === 'SENT') sent += 1;
        }
      } catch (err) {
        this.logger.error(
          `Scheduled reports failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
    return sent;
  }

  private async execute(
    s: {
      id: string;
      organizationId: string;
      name: string;
      reportKey: string;
      format: string;
      frequency: string;
      recipients: string[];
      departmentId: string | null;
      createdById: string;
    },
    today: string,
    countsAsToday: boolean,
  ): Promise<{ status: 'SENT' | 'FAILED'; error?: string }> {
    const organizationId = s.organizationId;
    const record = (status: 'SENT' | 'FAILED', error?: string) =>
      this.scopedPrisma.scheduledReport.updateMany({
        where: { id: s.id, organizationId },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: status,
          lastRunError: error ?? null,
          ...(countsAsToday && { lastRunDate: today }),
        },
      });
    try {
      const entry = SCHEDULED_REPORTS[s.reportKey];
      if (!entry) throw new Error('This report is no longer available.');
      const creator = await this.scopedPrisma.user.findFirst({
        where: {
          id: s.createdById,
          organizationId,
          isActive: true,
          role: { in: [Role.ADMIN, Role.HR] },
        },
        omit: { password: true },
      });
      if (!creator) {
        throw new Error(
          'The person who created this schedule is no longer an active Admin or HR user.',
        );
      }
      const period = periodFor(s.frequency as ScheduleFrequency, today);
      const payload = await entry.run({
        reports: this.reports,
        ops: this.ops,
        actor: creator,
        organizationId,
        period,
        department: s.departmentId ?? undefined,
      });
      const format = (s.format as ReportFormat) ?? 'xlsx';
      const captured = new CapturedResponse();
      await sendReportBranded(
        captured as unknown as Response,
        this.scopedPrisma,
        organizationId,
        { ...payload, format },
      );
      const file = await captured.done;
      const filename = `${payload.filename}_${today}.${format}`;
      const subject = `${s.name} - ${payload.title}`;
      const html = `<p>Hi,</p><p>Your scheduled report <b>${escapeHtml(s.name)}</b> (${escapeHtml(payload.title)}) is attached.</p><p>This is an automated email from your HR system. To change who receives it or how often, ask an Admin to edit it under Reports &gt; Scheduled.</p>`;
      for (const to of s.recipients) {
        await this.emailService.send({
          organizationId,
          to,
          subject,
          html,
          attachments: [{ filename, content: file }],
        });
      }
      await record('SENT');
      return { status: 'SENT' };
    } catch (err) {
      const message =
        (err as Error).message || 'The report could not be built.';
      this.logger.warn(`Scheduled report ${s.id} failed: ${message}`);
      await record('FAILED', message.slice(0, 300));
      return { status: 'FAILED', error: message };
    }
  }

  private audit(
    actor: Actor,
    action: string,
    targetId: string,
    details: Record<string, unknown>,
  ) {
    return this.auditLogService.log({
      actorId: actor.id,
      action,
      module: AuditModule.ORGANIZATION,
      organizationId: actor.organizationId,
      targetId,
      details,
    });
  }
}
