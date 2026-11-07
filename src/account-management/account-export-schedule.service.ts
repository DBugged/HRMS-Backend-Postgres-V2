// Purpose: monthly scheduled exports for a Company Admin: "email me the All data file on the 1st of every month".
// Responsibilities: save / list / remove schedules; a daily job builds each due export (the same builder as a manual export) and emails the
//   file to the chosen recipients; "run now" does the same on demand.
// Important: recipients must be active Admin or HR users of the SAME company, so company data can never be mailed to an outside address.
//   A company whose Data Export tab is switched off is skipped. A schedule runs at most once a month (it catches up if the server was down).
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash, randomBytes } from 'crypto';
import { backendPublicUrl } from '../common/backend-url';
import { AuditModule, type User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmailService } from '../notifications/email.service';
import { ModuleAccessService } from '../module-access/module-access.service';
import { readStoredFile } from '../files/file-storage.config';
import { AccountExportService } from './account-export.service';
import { AccountNotifier } from './account-notifier.service';
import { EXPORT_CATEGORIES_WITH_ALL, scheduleDue } from './account-logic';

type Caller = Omit<User, 'password'>;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_RECIPIENTS = 5;
const MAX_EXTRA = 3;
const CONFIRM_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
interface Extra { email: string; confirmedAt: string | null; tokenHash: string | null; tokenExpiresAt: string | null }

@Injectable()
export class AccountExportScheduleService {
  private readonly logger = new Logger(AccountExportScheduleService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly exports: AccountExportService,
    private readonly email: EmailService,
    private readonly audit: AuditLogService,
    private readonly modules: ModuleAccessService,
    private readonly notifier: AccountNotifier,
  ) {}

  async list(organizationId: string) {
    const rows = await this.prisma.ccExportSchedule.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } });
    return rows.map((s) => ({
      id: s.id,
      category: s.category,
      format: s.format,
      dayOfMonth: s.dayOfMonth,
      recipients: s.recipients as string[],
      extraRecipients: (s.extraRecipients as unknown as Extra[]).map((x) => ({ email: x.email, confirmed: !!x.confirmedAt })),
      enabled: s.enabled,
      lastRunAt: s.lastRunAt?.toISOString() ?? null,
      lastStatus: s.lastStatus,
      lastError: s.lastError,
      createdByName: s.createdByName,
    }));
  }

  /** The people a file may be emailed to: active Admin and HR users of this company. */
  async allowedRecipients(organizationId: string) {
    const users = await this.prisma.user.findMany({ where: { organizationId, isActive: true, role: { in: ['ADMIN', 'HR'] } }, select: { name: true, email: true }, orderBy: { name: 'asc' } });
    return users.map((u) => ({ name: u.name, email: u.email }));
  }

  /** Creates or updates one schedule for each chosen kind of data, all on the same day and to the same people. */
  async save(caller: Caller, dto: { category?: string; categories?: string[]; dayOfMonth?: number; recipients?: string[]; extraEmails?: string[]; enabled?: boolean; format?: string }) {
    const keys = [...new Set([...(dto.categories ?? []), ...(dto.category ? [dto.category] : [])])];
    if (!keys.length) throw new BadRequestException('Choose what to export.');
    const cats = keys.map((k) => EXPORT_CATEGORIES_WITH_ALL.find((c) => c.key === k));
    if (cats.some((c) => !c)) throw new BadRequestException('One of the data choices is not valid.');
    const chosen = cats as { key: string; label: string }[];
    const day = Number(dto.dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new BadRequestException('Choose a day of the month from 1 to 31.');
    const allowed = new Map((await this.allowedRecipients(caller.organizationId)).map((u) => [u.email.toLowerCase(), u.email]));
    const wanted = [...new Set((dto.recipients ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
    const extraWanted = [...new Set((dto.extraEmails ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
    if (!wanted.length && !extraWanted.length) throw new BadRequestException('Choose at least one person to send it to.');
    if (extraWanted.length > MAX_EXTRA) throw new BadRequestException(`You can add up to ${MAX_EXTRA} outside email addresses.`);
    if (extraWanted.some((e) => !EMAIL_RE.test(e) || e.length > 120)) throw new BadRequestException('One of the extra email addresses is not valid.');
    if (wanted.length > MAX_RECIPIENTS) throw new BadRequestException(`You can send it to up to ${MAX_RECIPIENTS} people.`);
    if (wanted.some((e) => !allowed.has(e))) throw new BadRequestException('Files can only be sent to active Admin or HR users of your company.');
    const recipients = wanted.map((e) => allowed.get(e)!);
    const outside = extraWanted.filter((e) => !allowed.has(e));
    // One confirmation link per outside address, however many kinds of data it was asked for (a click confirms them all).
    const tokens = new Map(outside.map((e) => [e, randomBytes(24).toString('hex')]));
    const expires = new Date(Date.now() + CONFIRM_DAYS * 86_400_000).toISOString();
    const pending = new Map<string, string[]>(); // address -> labels still waiting for confirmation
    const ids: string[] = [];
    for (const cat of chosen) {
      const where = { organizationId_category: { organizationId: caller.organizationId, category: cat.key } };
      const existing = await this.prisma.ccExportSchedule.findUnique({ where });
      const before = new Map(((existing?.extraRecipients ?? []) as unknown as Extra[]).map((x) => [x.email, x]));
      // A confirmed address stays confirmed; a new or still-unconfirmed one waits for its link.
      const extras: Extra[] = outside.map((email) => {
        const prev = before.get(email);
        if (prev?.confirmedAt) return prev;
        pending.set(email, [...(pending.get(email) ?? []), cat.label]);
        return { email, confirmedAt: null, tokenHash: sha(tokens.get(email)!), tokenExpiresAt: expires };
      });
      const format = cat.key !== 'ALL' && dto.format === 'CSV' ? 'CSV' : 'XLSX';
      const row = await this.prisma.ccExportSchedule.upsert({
        where,
        create: { organizationId: caller.organizationId, category: cat.key, format, dayOfMonth: day, recipients, extraRecipients: extras as never, enabled: dto.enabled ?? true, createdById: caller.id, createdByName: caller.name },
        update: { format, dayOfMonth: day, recipients, extraRecipients: extras as never, enabled: dto.enabled ?? true },
      });
      ids.push(row.id);
      await this.audit.log({ actorId: caller.id, action: 'ACCOUNT_EXPORT_SCHEDULE_SAVED', module: AuditModule.ORGANIZATION, organizationId: caller.organizationId, targetId: row.id, details: { category: cat.key, dayOfMonth: day, recipients: recipients.length, outsideAddresses: extras.length, enabled: row.enabled } });
    }
    for (const [email, labels] of pending) {
      await this.email
        .send({
          to: email,
          organizationId: caller.organizationId,
          subject: `Please confirm: monthly data export from ${caller.name}`,
          html: `<p>Hello,</p><p><b>${esc(caller.name)}</b> has asked D'Rect HR to email a monthly file of their company's data to this address: <b>${esc(labels.join(', '))}</b>.</p><p>Only click the link if you expect this. Until you confirm, nothing is sent to you.</p><p><a href="${backendPublicUrl()}/public/account-export/confirm?token=${tokens.get(email)}">Yes, send me the monthly file${labels.length > 1 ? 's' : ''}</a></p><p>The link works for ${CONFIRM_DAYS} days. If you did not expect this email, ignore it.</p><p>D'Bugged Programmers</p>`,
        })
        .catch(() => undefined);
    }
    return { ids, id: ids[0], saved: ids.length, confirmationsSent: pending.size };
  }

  /** Called from the link in the confirmation email. Confirms that outside address on every schedule it was asked for. */
  async confirmRecipient(token: string): Promise<'OK' | 'INVALID'> {
    if (!/^[0-9a-f]{48}$/.test(token)) return 'INVALID';
    const hash = sha(token);
    const rows = await this.prisma.ccExportSchedule.findMany({ where: { NOT: { extraRecipients: { equals: [] } } }, take: 5000 });
    let confirmed = false;
    for (const s of rows) {
      const list = s.extraRecipients as unknown as Extra[];
      const i = list.findIndex((x) => x.tokenHash === hash && !x.confirmedAt && x.tokenExpiresAt && new Date(x.tokenExpiresAt) > new Date());
      if (i < 0) continue;
      list[i] = { ...list[i], confirmedAt: new Date().toISOString(), tokenHash: null, tokenExpiresAt: null };
      await this.prisma.ccExportSchedule.update({ where: { id: s.id }, data: { extraRecipients: list as never } });
      await this.audit.log({ actorId: s.createdById, action: 'ACCOUNT_EXPORT_RECIPIENT_CONFIRMED', module: AuditModule.ORGANIZATION, organizationId: s.organizationId, targetId: s.id, details: { category: s.category } }).catch(() => undefined);
      confirmed = true;
    }
    return confirmed ? 'OK' : 'INVALID';
  }

  async remove(caller: Caller, id: string) {
    const row = await this.prisma.ccExportSchedule.findFirst({ where: { id, organizationId: caller.organizationId } });
    if (!row) throw new NotFoundException('Schedule not found.');
    await this.prisma.ccExportSchedule.delete({ where: { id } });
    await this.audit.log({ actorId: caller.id, action: 'ACCOUNT_EXPORT_SCHEDULE_DELETED', module: AuditModule.ORGANIZATION, organizationId: caller.organizationId, targetId: id, details: { category: row.category } });
    return { ok: true };
  }

  /** Builds and emails one schedule now (also used by the daily job). */
  async runNow(organizationId: string, id: string) {
    const s = await this.prisma.ccExportSchedule.findFirst({ where: { id, organizationId } });
    if (!s) throw new NotFoundException('Schedule not found.');
    return this.run(s);
  }

  private async run(s: { id: string; organizationId: string; category: string; format: string; recipients: unknown; extraRecipients?: unknown; createdById: string }) {
    const to = [...(s.recipients as string[]), ...((s.extraRecipients ?? []) as Extra[]).filter((x) => x.confirmedAt).map((x) => x.email)];
    // The creator when still active, otherwise any active Admin, owns the run.
    const owner =
      (await this.prisma.user.findFirst({ where: { id: s.createdById, organizationId: s.organizationId, isActive: true, role: { in: ['ADMIN', 'HR'] } } })) ??
      (await this.prisma.user.findFirst({ where: { organizationId: s.organizationId, isActive: true, role: 'ADMIN' } }));
    if (!owner) throw new ConflictException('No active Admin to run this export.');
    const caller = owner as Caller;
    const cat = EXPORT_CATEGORIES_WITH_ALL.find((c) => c.key === s.category);
    let status = 'SENT';
    let error: string | null = null;
    try {
      const { id: exportId } = await this.exports.create(caller, { category: s.category, format: s.format }, { wait: true, silent: true });
      const rec = await this.prisma.ccExport.findFirst({ where: { id: exportId, organizationId: s.organizationId } });
      if (!rec || rec.status !== 'COMPLETED' || !rec.fileKey) throw new Error(rec?.error ?? 'The export could not be generated.');
      const file = await readStoredFile(rec.fileKey);
      if (!file) throw new Error('The generated file could not be read.');
      const small = file.length <= MAX_ATTACHMENT_BYTES;
      const label = cat?.label ?? s.category;
      if (!to.length) throw new Error('There is nobody to send it to: confirm the extra email addresses or choose a person.');
      for (const address of to) {
        await this.email.send({
          to: address,
          organizationId: s.organizationId,
          subject: `Your scheduled data export: ${label}`,
          html: `<p>Hello,</p><p>Your scheduled export <b>${label}</b> (${rec.rowCount ?? 0} rows) is ready.</p>${small ? '<p>The file is attached.</p>' : '<p>The file is too large to attach. Sign in to D\'Rect HR, open Account Management > Data Export and download it within 24 hours.</p>'}<p>This file contains confidential company data. Please store and share it carefully.</p><p>D'Bugged Programmers</p>`,
          ...(small ? { attachments: [{ filename: rec.fileName ?? 'export', content: file }] } : {}),
        });
      }
      await this.audit.log({ actorId: caller.id, action: 'ACCOUNT_EXPORT_SCHEDULE_SENT', module: AuditModule.ORGANIZATION, organizationId: s.organizationId, targetId: s.id, details: { category: s.category, recipients: to.length } });
    } catch (e) {
      status = 'FAILED';
      error = ((e as Error).message ?? 'Failed').slice(0, 300);
      await this.notifier.toAdmins(s.organizationId, { title: 'A scheduled data export failed', message: `${cat?.label ?? s.category}: ${error}`, link: '/account-export' }).catch(() => undefined);
    }
    await this.prisma.ccExportSchedule.update({ where: { id: s.id }, data: { lastRunAt: new Date(), lastStatus: status, lastError: error } });
    return { status, error };
  }

  @Cron('0 3 * * *')
  async daily() {
    try {
      const now = new Date();
      const rows = await this.prisma.ccExportSchedule.findMany({ where: { enabled: true }, take: 1000 });
      for (const s of rows) {
        if (!scheduleDue(s.dayOfMonth, s.lastRunAt, now)) continue;
        if ((await this.modules.disabledFor(s.organizationId)).has('module.account_export')) continue;
        await this.run(s).catch((e) => this.logger.warn(`Scheduled export ${s.id} failed: ${(e as Error).message}`));
      }
    } catch (e) {
      this.logger.error(`Scheduled exports job failed: ${(e as Error).message}`);
    }
  }
}
