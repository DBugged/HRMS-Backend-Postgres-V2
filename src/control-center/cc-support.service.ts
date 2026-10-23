// Purpose: support tickets, announcements, the audit trail, platform settings and Super Admin management for the panel.
// Important: Super Admin changes keep at least one active Owner and never let someone remove or deactivate themselves.
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, SuperAdmin } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CcAuthService } from './cc-auth.service';
import { EmailService } from '../notifications/email.service';
import { normalizeEmail } from './cc-auth-rules';
import { paging, type PageQuery } from './cc-util';

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const pick = (b: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in b).map((k) => [k, b[k]]));

@Injectable()
export class CcSupportService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient, private readonly auth: CcAuthService, private readonly email: EmailService) {}

  // ---------------- tickets ----------------
  private async ticketOut(t: Prisma.CcTicketGetPayload<{ include: { organization: true; comments: true } }>, withComments: boolean) {
    const assignee = t.assigneeId ? await this.prisma.superAdmin.findUnique({ where: { id: t.assigneeId }, select: { name: true } }) : null;
    return {
      id: t.id, organizationId: t.organizationId, organizationName: t.organization ? t.organization.companyName || t.organization.name : null,
      subject: t.subject, body: t.body, status: t.status, priority: t.priority, assigneeId: t.assigneeId, assigneeName: assignee?.name ?? null,
      createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(),
      ...(withComments ? { comments: t.comments.map((c) => ({ id: c.id, ticketId: c.ticketId, authorId: c.authorId, authorName: c.authorName, body: c.body, internal: c.internal, createdAt: c.createdAt.toISOString() })) } : {}),
    };
  }
  private readonly tInc = { organization: true, comments: { orderBy: { createdAt: 'asc' as const } } };

  async listTickets(q: PageQuery & { status?: string; priority?: string; organizationId?: string; assigneeId?: string }) {
    const { page, pageSize, skip, take } = paging(q);
    const where: Prisma.CcTicketWhereInput = {
      ...(q.status ? { status: q.status } : {}), ...(q.priority ? { priority: q.priority } : {}),
      ...(q.organizationId ? { organizationId: q.organizationId } : {}), ...(q.assigneeId ? { assigneeId: q.assigneeId } : {}),
      ...(q.q ? { OR: [{ subject: { contains: q.q, mode: 'insensitive' } }, { body: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([this.prisma.ccTicket.findMany({ where, include: this.tInc, orderBy: { createdAt: 'desc' }, skip, take }), this.prisma.ccTicket.count({ where })]);
    return { data: await Promise.all(rows.map((t) => this.ticketOut(t, false))), page, pageSize, total };
  }
  async getTicket(id: string) {
    const t = await this.prisma.ccTicket.findUnique({ where: { id }, include: this.tInc });
    if (!t) throw new NotFoundException('Ticket not found.');
    return this.ticketOut(t, true);
  }
  async createTicket(b: { organizationId?: string; subject: string; body: string; priority?: string }, by: SuperAdmin) {
    if (!b.subject?.trim() || !b.body?.trim()) throw new BadRequestException('Subject and details are required.');
    if (b.organizationId && !(await this.prisma.organization.findFirst({ where: { id: b.organizationId }, select: { id: true } }))) throw new NotFoundException('Organization not found.');
    const t = await this.prisma.ccTicket.create({ data: { organizationId: b.organizationId || null, subject: b.subject.trim(), body: b.body, priority: b.priority ?? 'NORMAL', createdById: by.id }, include: this.tInc });
    return this.ticketOut(t, true);
  }
  async updateTicket(id: string, b: { status?: string; priority?: string; assigneeId?: string | null }) {
    await this.getTicket(id);
    if (b.assigneeId && !(await this.prisma.superAdmin.findUnique({ where: { id: b.assigneeId } }))) throw new NotFoundException('Assignee not found.');
    const t = await this.prisma.ccTicket.update({ where: { id }, data: pick(b, ['status', 'priority', 'assigneeId']), include: this.tInc });
    return this.ticketOut(t, true);
  }
  async addComment(id: string, b: { body: string; internal?: boolean }, by: SuperAdmin) {
    const t = await this.prisma.ccTicket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Ticket not found.');
    if (!b.body?.trim()) throw new BadRequestException('Write a comment first.');
    const c = await this.prisma.ccTicketComment.create({ data: { ticketId: id, organizationId: t.organizationId, authorId: by.id, authorName: by.name, body: b.body, internal: !!b.internal } });
    return { id: c.id, ticketId: id, authorId: c.authorId, authorName: c.authorName, body: c.body, internal: c.internal, createdAt: c.createdAt.toISOString() };
  }

  // ---------------- announcements ----------------
  private annOut(a: Prisma.CcAnnouncementGetPayload<Record<string, never>>) {
    const now = new Date();
    const status = !a.published ? 'DRAFT' : a.endsAt && a.endsAt < now ? 'ENDED' : a.startsAt && a.startsAt > now ? 'SCHEDULED' : 'LIVE';
    return { id: a.id, title: a.title, body: a.body, audience: a.audience, audienceRef: a.audienceRef, startsAt: iso(a.startsAt), endsAt: iso(a.endsAt), severity: a.severity, status, createdAt: a.createdAt.toISOString() };
  }
  private annData(b: Record<string, unknown>) {
    const d = pick(b, ['title', 'body', 'audience', 'audienceRef', 'severity']) as Record<string, unknown>;
    if ('startsAt' in b) d.startsAt = b.startsAt ? new Date(b.startsAt as string) : null;
    if ('endsAt' in b) d.endsAt = b.endsAt ? new Date(b.endsAt as string) : null;
    if (b.status === 'SCHEDULED' || b.status === 'LIVE') d.published = true;
    return d as Prisma.CcAnnouncementUncheckedCreateInput;
  }
  async listAnnouncements(q: PageQuery & { status?: string }) {
    const { page, pageSize, skip, take } = paging(q);
    const rows = (await this.prisma.ccAnnouncement.findMany({ where: q.q ? { title: { contains: q.q, mode: 'insensitive' } } : {}, orderBy: { createdAt: 'desc' } })).map((a) => this.annOut(a)).filter((a) => !q.status || a.status === q.status);
    return { data: rows.slice(skip, skip + take), page, pageSize, total: rows.length };
  }
  async getAnnouncement(id: string) {
    const a = await this.prisma.ccAnnouncement.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Announcement not found.');
    return this.annOut(a);
  }
  async createAnnouncement(b: Record<string, unknown>) {
    const d = this.annData(b);
    if (!d.title || !d.body) throw new BadRequestException('Title and message are required.');
    return this.annOut(await this.prisma.ccAnnouncement.create({ data: d }));
  }
  async updateAnnouncement(id: string, b: Record<string, unknown>) {
    await this.getAnnouncement(id);
    return this.annOut(await this.prisma.ccAnnouncement.update({ where: { id }, data: this.annData(b) }));
  }
  async removeAnnouncement(id: string) {
    await this.getAnnouncement(id);
    await this.prisma.ccAnnouncement.delete({ where: { id } });
  }
  /** Email a published announcement to the admins of the companies it targets (active companies only; capped at 500 people). */
  async emailAnnouncement(id: string) {
    const a = await this.prisma.ccAnnouncement.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Announcement not found.');
    if (!a.published) throw new BadRequestException('Publish the announcement before emailing it.');
    let orgIds: string[];
    if (a.audience === 'ORG' && a.audienceRef) orgIds = [a.audienceRef];
    else if (a.audience === 'PLAN' && a.audienceRef)
      orgIds = (await this.prisma.ccSubscription.findMany({ where: { planId: a.audienceRef, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, select: { organizationId: true } })).map((s) => s.organizationId);
    else orgIds = (await this.prisma.organization.findMany({ where: { platformStatus: 'ACTIVE' }, select: { id: true } })).map((o) => o.id);
    if (!orgIds.length) return { sent: 0, failed: 0, companies: 0 };
    const people = await this.prisma.$queryRaw<{ email: string; name: string }[]>`SELECT DISTINCT email, name FROM users WHERE "organizationId" = ANY(${orgIds}::text[]) AND role = 'ADMIN' AND "isActive" LIMIT 500`;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    let sent = 0;
    let failed = 0;
    for (const p of people) {
      await this.email.send({ to: p.email, subject: a.title, html: `<p>Hello ${esc(p.name)},</p><p><b>${esc(a.title)}</b></p><p>${esc(a.body).replace(/\n/g, '<br>')}</p><p>D'Bugged Programmers</p>` }).then(() => sent++).catch(() => failed++);
    }
    return { sent, failed, companies: orgIds.length };
  }

  async setPublished(id: string, published: boolean) {
    await this.getAnnouncement(id);
    return this.annOut(await this.prisma.ccAnnouncement.update({ where: { id }, data: { published } }));
  }

  /**
   * What a company's employees should see right now: published announcements inside their dates that target everyone,
   * the company's plan, or the company itself. Newest and most severe first.
   */
  async liveFor(organizationId: string) {
    const now = new Date();
    const sub = await this.prisma.ccSubscription.findFirst({ where: { organizationId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, orderBy: { createdAt: 'desc' }, select: { planId: true } });
    const rows = await this.prisma.ccAnnouncement.findMany({
      where: {
        published: true,
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
        OR: [{ audience: 'ALL' }, { audience: 'ORG', audienceRef: organizationId }, ...(sub ? [{ audience: 'PLAN', audienceRef: sub.planId }] : [])],
      },
      orderBy: { createdAt: 'desc' },
    });
    const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as Record<string, number>;
    return rows.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)).map((a) => ({ id: a.id, title: a.title, body: a.body, severity: a.severity, startsAt: iso(a.startsAt), endsAt: iso(a.endsAt) }));
  }

  // ---------------- audit log ----------------
  private auditWhere(q: Record<string, string | undefined>): Prisma.CcAuditLogWhereInput {
    return {
      ...(q.actorId ? { actorId: q.actorId } : {}), ...(q.action ? { action: { contains: q.action, mode: 'insensitive' } } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}), ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.from || q.to ? { at: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    };
  }
  private auditOut(a: Prisma.CcAuditLogGetPayload<Record<string, never>>) {
    return { id: a.id, at: a.at.toISOString(), actorId: a.actorId, actorEmail: a.actorEmail, ip: a.ip, userAgent: a.userAgent, action: a.action, entityType: a.entityType, entityId: a.entityId, before: a.before, after: a.after, context: a.context, requestId: a.requestId };
  }
  async listAudit(q: PageQuery & Record<string, string | undefined>) {
    const { page, pageSize, skip, take, dir } = paging(q);
    const where = this.auditWhere(q);
    const [rows, total] = await Promise.all([this.prisma.ccAuditLog.findMany({ where, orderBy: { at: q.sort ? dir : 'desc' }, skip, take }), this.prisma.ccAuditLog.count({ where })]);
    return { data: rows.map((a) => this.auditOut(a)), page, pageSize, total };
  }
  async getAudit(id: string) {
    const a = await this.prisma.ccAuditLog.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Entry not found.');
    return this.auditOut(a);
  }
  /** Up to 10,000 newest matching entries as CSV or JSON text. */
  async exportAudit(q: Record<string, string | undefined>, format: string) {
    const rows = (await this.prisma.ccAuditLog.findMany({ where: this.auditWhere(q), orderBy: { at: 'desc' }, take: 10_000 })).map((a) => this.auditOut(a));
    if (format === 'json') return { type: 'application/json', body: JSON.stringify(rows, null, 2) };
    const cols = ['at', 'actorEmail', 'action', 'entityType', 'entityId', 'ip'] as const;
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return { type: 'text/csv', body: [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') };
  }
  async record(e: { actor: SuperAdmin; ip?: string; userAgent?: string; action: string; entityType: string; entityId: string; after?: unknown; requestId?: string }) {
    await this.prisma.ccAuditLog.create({ data: { actorId: e.actor.id, actorEmail: e.actor.email, ip: e.ip ?? '', userAgent: (e.userAgent ?? '').slice(0, 300), action: e.action, entityType: e.entityType, entityId: e.entityId, after: (e.after ?? undefined) as never, requestId: e.requestId ?? '' } });
  }

  // ---------------- platform settings ----------------
  private setOut(s: Prisma.CcSettingGetPayload<Record<string, never>>) {
    return { key: s.key, value: s.value, type: s.type, restricted: s.restricted, description: s.description, updatedAt: s.updatedAt.toISOString() };
  }
  async listSettings() { return (await this.prisma.ccSetting.findMany({ orderBy: { key: 'asc' } })).map((s) => this.setOut(s)); }
  async getSetting(key: string) {
    const s = await this.prisma.ccSetting.findUnique({ where: { key } });
    if (!s) throw new NotFoundException('Setting not found.');
    return this.setOut(s);
  }
  async updateSetting(key: string, value: unknown) {
    const s = await this.prisma.ccSetting.findUnique({ where: { key } });
    if (!s) throw new NotFoundException('Setting not found.');
    if (s.restricted) throw new ForbiddenException('This setting is restricted and cannot be changed here.');
    const ok = s.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : s.type === 'bool' ? typeof value === 'boolean' : s.type === 'string' ? typeof value === 'string' : true;
    if (!ok) throw new BadRequestException(`This setting needs a ${s.type} value.`);
    return this.setOut(await this.prisma.ccSetting.update({ where: { key }, data: { value: value as never } }));
  }
  /** A numeric setting with a fallback, for billing code. */
  async numberSetting(key: string, fallback: number) {
    const s = await this.prisma.ccSetting.findUnique({ where: { key } });
    return typeof s?.value === 'number' ? s.value : fallback;
  }

  // ---------------- super admins ----------------
  private adminOut(a: SuperAdmin) {
    return { id: a.id, email: a.email, name: a.name, role: a.role, status: a.status, lastLoginAt: iso(a.lastLoginAt), createdAt: a.createdAt.toISOString() };
  }
  async listAdmins(q: PageQuery & { status?: string; role?: string }) {
    const { page, pageSize, skip, take } = paging(q);
    const where: Prisma.SuperAdminWhereInput = {
      ...(q.status ? { status: q.status as never } : {}), ...(q.role ? { role: q.role as never } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([this.prisma.superAdmin.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }), this.prisma.superAdmin.count({ where })]);
    return { data: rows.map((a) => this.adminOut(a)), page, pageSize, total };
  }
  private async admin(id: string) {
    const a = await this.prisma.superAdmin.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Super admin not found.');
    return a;
  }
  async getAdmin(id: string) { return this.adminOut(await this.admin(id)); }
  private async guardLastOwner(target: SuperAdmin) {
    if (target.role !== 'OWNER' || target.status !== 'ACTIVE') return;
    if ((await this.prisma.superAdmin.count({ where: { role: 'OWNER', status: 'ACTIVE' } })) <= 1) throw new ConflictException('At least one active Owner must remain.');
  }
  async createAdmin(b: { email: string; name: string; role: string }, by: SuperAdmin) {
    const email = normalizeEmail(b.email ?? '');
    if (!email || !b.name?.trim()) throw new BadRequestException('Name and email are required.');
    if (b.role === 'OWNER' && by.role !== 'OWNER') throw new ForbiddenException('Only an Owner can create another Owner.');
    if (await this.prisma.superAdmin.findUnique({ where: { email } })) throw new ConflictException('A super admin with this email already exists.');
    const a = await this.prisma.superAdmin.create({ data: { email, name: b.name.trim(), role: b.role as never, status: 'INVITED' } });
    await this.auth.forgotPassword(email).catch(() => undefined); // emails a link to set the password; never blocks creating
    return this.adminOut(a);
  }
  async updateAdmin(id: string, b: { name?: string; role?: string }, by: SuperAdmin) {
    const a = await this.admin(id);
    if (b.role && b.role !== a.role) {
      if (id === by.id) throw new ForbiddenException('You cannot change your own role.');
      if ((b.role === 'OWNER' || a.role === 'OWNER') && by.role !== 'OWNER') throw new ForbiddenException('Only an Owner can change Owner roles.');
      await this.guardLastOwner(a);
    }
    return this.adminOut(await this.prisma.superAdmin.update({ where: { id }, data: { ...(b.name ? { name: b.name.trim() } : {}), ...(b.role ? { role: b.role as never } : {}) } }));
  }
  async inviteAdmin(id: string) {
    const a = await this.admin(id);
    await this.auth.forgotPassword(a.email);
    return this.adminOut(a);
  }
  async deactivateAdmin(id: string, by: SuperAdmin) {
    const a = await this.admin(id);
    if (id === by.id) throw new ForbiddenException('You cannot deactivate yourself.');
    await this.guardLastOwner(a);
    await this.prisma.superAdminSession.deleteMany({ where: { superAdminId: id } });
    return this.adminOut(await this.prisma.superAdmin.update({ where: { id }, data: { status: 'DEACTIVATED' } }));
  }
  async removeAdmin(id: string, by: SuperAdmin) {
    const a = await this.admin(id);
    if (id === by.id) throw new ForbiddenException('You cannot remove yourself.');
    await this.guardLastOwner(a);
    await this.prisma.superAdminSession.deleteMany({ where: { superAdminId: id } });
    await this.prisma.superAdmin.delete({ where: { id } });
  }
}
