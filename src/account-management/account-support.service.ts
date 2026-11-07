// Purpose: Company Admin's Support & Tickets: raise a ticket to the platform support team, follow its status, reply, close/reopen.
// Important: tickets are always scoped to the signed-in user's organisation; internal staff notes (internal=true) are never shown;
//   attachments are stored as durable org-prefixed file keys and returned as short-lived signed links.
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditModule, type User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { isKeyAllowedForOrg, resolveIncomingFileValue, signFileToken } from '../files/file-token';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_REPLY_BLOCKED, normalizeTicketStatus } from './account-logic';

type Caller = Omit<User, 'password'>;
type Attachment = { name: string; key: string };

@Injectable()
export class AccountSupportService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly auditLog: AuditLogService,
  ) {}

  private cleanAttachments(organizationId: string, input: unknown): Attachment[] {
    if (input == null) return [];
    if (!Array.isArray(input) || input.length > 5) throw new BadRequestException('Attach up to 5 files.');
    return input.map((a) => {
      const name = typeof a?.name === 'string' ? a.name.slice(0, 200) : '';
      const key = resolveIncomingFileValue(organizationId, a?.url, null);
      if (!name || !key || !isKeyAllowedForOrg(organizationId, key) || !key.startsWith(`${organizationId}/`)) throw new BadRequestException('An attachment is not valid. Upload it again.');
      return { name, key };
    });
  }

  private outAttachments(organizationId: string, value: unknown) {
    return (Array.isArray(value) ? (value as Attachment[]) : []).map((a) => ({ name: a.name, url: `/files/${signFileToken(organizationId, a.key)}` }));
  }

  async list(organizationId: string) {
    const rows = await this.prisma.ccTicket.findMany({ where: { organizationId }, orderBy: { updatedAt: 'desc' }, take: 200 });
    // Who on the support team is handling each ticket (name only).
    const staff = await this.prisma.superAdmin.findMany({ where: { id: { in: [...new Set(rows.map((t) => t.assigneeId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
    const staffName = new Map(staff.map((s) => [s.id, s.name]));
    return rows.map((t) => ({ id: t.id, subject: t.subject, category: t.category, priority: t.priority, assignee: t.assigneeId ? staffName.get(t.assigneeId) ?? null : null, status: normalizeTicketStatus(t.status), createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString() }));
  }

  async get(organizationId: string, id: string) {
    const t = await this.prisma.ccTicket.findFirst({ where: { id, organizationId }, include: { comments: { where: { internal: false }, orderBy: { createdAt: 'asc' } } } });
    if (!t) throw new NotFoundException('Ticket not found.');
    const authorIds = [...new Set(t.comments.map((c) => c.authorId))];
    const companyAuthors = new Set((await this.prisma.user.findMany({ where: { organizationId, id: { in: authorIds } }, select: { id: true } })).map((u) => u.id));
    return {
      id: t.id,
      subject: t.subject,
      body: t.body,
      category: t.category,
      priority: t.priority,
      assignee: t.assigneeId ? (await this.prisma.superAdmin.findUnique({ where: { id: t.assigneeId }, select: { name: true } }))?.name ?? null : null,
      status: normalizeTicketStatus(t.status),
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      attachments: this.outAttachments(organizationId, t.attachments),
      comments: t.comments.map((c) => ({ id: c.id, authorName: c.authorName, fromSupport: !companyAuthors.has(c.authorId), body: c.body, createdAt: c.createdAt.toISOString(), attachments: this.outAttachments(organizationId, c.attachments) })),
    };
  }

  async create(caller: Caller, dto: { subject?: string; body?: string; category?: string; priority?: string; attachments?: unknown }) {
    const subject = (dto.subject ?? '').trim();
    const body = (dto.body ?? '').trim();
    if (!subject || subject.length > 200) throw new BadRequestException('Add a short subject (up to 200 characters).');
    if (!body || body.length > 5000) throw new BadRequestException('Describe the issue (up to 5000 characters).');
    const category = dto.category ?? '';
    const priority = dto.priority ?? '';
    if (!TICKET_CATEGORIES.includes(category as never)) throw new BadRequestException('Choose a category.');
    if (!TICKET_PRIORITIES.includes(priority as never)) throw new BadRequestException('Choose a priority.');
    const attachments = this.cleanAttachments(caller.organizationId, dto.attachments);
    const t = await this.prisma.ccTicket.create({
      data: { organizationId: caller.organizationId, subject, body, category, priority, createdById: caller.id, attachments },
    });
    await this.prisma.ccAlert
      .create({ data: { kind: 'TICKET', title: `New support ticket: ${subject.slice(0, 80)}`, body: body.slice(0, 300), organizationId: caller.organizationId, dedupeKey: `ticket:${t.id}` } })
      .catch(() => undefined);
    await this.auditLog.log({ actorId: caller.id, action: 'SUPPORT_TICKET_CREATED', module: AuditModule.ORGANIZATION, organizationId: caller.organizationId, targetId: t.id, details: { category, priority } });
    return { id: t.id };
  }

  async reply(caller: Caller, id: string, dto: { body?: string; attachments?: unknown }) {
    const t = await this.prisma.ccTicket.findFirst({ where: { id, organizationId: caller.organizationId } });
    if (!t) throw new NotFoundException('Ticket not found.');
    if (TICKET_REPLY_BLOCKED.has(normalizeTicketStatus(t.status))) throw new ConflictException('This ticket is closed. Reopen it to reply.');
    const body = (dto.body ?? '').trim();
    if (!body || body.length > 5000) throw new BadRequestException('Write your reply (up to 5000 characters).');
    const attachments = this.cleanAttachments(caller.organizationId, dto.attachments);
    await this.prisma.ccTicketComment.create({ data: { ticketId: id, organizationId: caller.organizationId, authorId: caller.id, authorName: caller.name, body, attachments } });
    // A customer reply puts the ticket back in the support team's queue.
    if (normalizeTicketStatus(t.status) === 'WAITING_CUSTOMER') await this.prisma.ccTicket.update({ where: { id }, data: { status: 'IN_PROGRESS' } });
    else await this.prisma.ccTicket.update({ where: { id }, data: { updatedAt: new Date() } });
    return { ok: true };
  }

  async setClosed(caller: Caller, id: string, closed: boolean) {
    const t = await this.prisma.ccTicket.findFirst({ where: { id, organizationId: caller.organizationId } });
    if (!t) throw new NotFoundException('Ticket not found.');
    const status = normalizeTicketStatus(t.status);
    if (closed && status === 'CLOSED') throw new ConflictException('The ticket is already closed.');
    if (!closed && status !== 'CLOSED' && status !== 'RESOLVED') throw new ConflictException('Only a closed or resolved ticket can be reopened.');
    await this.prisma.ccTicket.update({ where: { id }, data: { status: closed ? 'CLOSED' : 'OPEN' } });
    await this.auditLog.log({ actorId: caller.id, action: closed ? 'SUPPORT_TICKET_CLOSED' : 'SUPPORT_TICKET_REOPENED', module: AuditModule.ORGANIZATION, organizationId: caller.organizationId, targetId: id });
    return { ok: true };
  }
}
