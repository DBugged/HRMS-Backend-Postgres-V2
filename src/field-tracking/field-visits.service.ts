// Purpose: Client visits for field employees - planned by a manager / HR (or by the employee), checked in and out from the app
//   at the client's location, and reported.
// Responsibilities: create / edit / cancel a planned visit; check in (records how far the phone was from the client) and out;
//   list visits within the viewer's scope; the report of visits, time at clients and distance travelled; close stale visits at night.
// Important: part of the Live Tracking feature (same company switch). Visits are for people live tracking is on for. A check-in
//   needs the person to be punched in and the visit to be today's; being far from the client is recorded and flagged, never
//   refused. Every by-id write is scoped by company (updateMany) because the tenant-scoped client refuses update/delete by id.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  FieldVisitStatus,
  NotificationCategory,
  Role,
  type User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { featureEnabledFor } from '../module-access/module-gate';
import { inReviewerScope, reviewerScope } from '../common/dept-scope';
import { dateStrInOrgTz, dayRangeInOrgTz } from '../common/org-date';
import {
  FieldTrackingService,
  FIELD_TRACKING_FLAG,
} from './field-tracking.service';
import { summarizeRoute } from './field-tracking-logic';
import {
  addDays,
  assessCheckIn,
  cleanVisitInput,
  daysBetween,
  summarizeVisits,
  visitMinutes,
  VISIT,
  type VisitInput,
} from './field-visits-logic';

type Actor = Pick<User, 'id' | 'role' | 'organizationId' | 'name'> &
  Partial<User>;

export interface CreateVisitInput extends VisitInput {
  employeeId?: string;
  scheduledFor?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class FieldVisitsService {
  private readonly logger = new Logger(FieldVisitsService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: ExtendedPrismaClient,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly notifications: NotificationsService,
    private readonly tracking: FieldTrackingService,
  ) {}

  private async assertOn(organizationId: string) {
    if (!(await featureEnabledFor(organizationId, FIELD_TRACKING_FLAG))) {
      throw new ForbiddenException(
        'Live tracking is not switched on for this company.',
      );
    }
  }

  private async tz(organizationId: string): Promise<string> {
    const org = await this.db.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone || 'Asia/Kolkata';
  }

  private async today(organizationId: string): Promise<string> {
    return dateStrInOrgTz(await this.tz(organizationId), new Date());
  }

  // May this person plan / edit / cancel visits for `employeeId`? Themselves, or someone they look after.
  private async mayManage(actor: Actor, employeeId: string): Promise<boolean> {
    if (actor.id === employeeId) return true;
    if (actor.role === Role.EMPLOYEE) return false;
    return inReviewerScope(
      this.db,
      actor as never,
      actor.organizationId,
      employeeId,
    );
  }

  // May this person change / cancel a visit? Whoever created it, or a manager / HR / Admin who looks after the employee.
  // (An employee cannot change a visit their manager planned for them.)
  private async mayChange(
    actor: Actor,
    v: { createdById: string; employeeId: string },
  ): Promise<boolean> {
    if (v.createdById === actor.id) return true;
    if (actor.role === Role.EMPLOYEE) return false;
    return inReviewerScope(
      this.db,
      actor as never,
      actor.organizationId,
      v.employeeId,
    );
  }

  async create(actor: Actor, input: CreateVisitInput) {
    await this.assertOn(actor.organizationId);
    const employeeId = input.employeeId || actor.id;
    if (!(await this.mayManage(actor, employeeId)))
      throw new ForbiddenException(
        'You can only plan visits for people you look after.',
      );
    const person = await this.db.user.findFirst({
      where: {
        id: employeeId,
        organizationId: actor.organizationId,
        isActive: true,
      },
      select: { id: true, name: true, fieldTrackingEnabled: true },
    });
    if (!person) throw new NotFoundException('Employee not found.');
    if (!person.fieldTrackingEnabled) {
      throw new BadRequestException(
        'Visits are for field employees. Switch live tracking on for this person first.',
      );
    }
    const clean = cleanVisitInput(input);
    if (!clean.ok) throw new BadRequestException(clean.reason);
    const today = await this.today(actor.organizationId);
    const scheduledFor =
      input.scheduledFor && DATE.test(input.scheduledFor)
        ? input.scheduledFor
        : today;
    if (scheduledFor < today)
      throw new BadRequestException(
        'A visit cannot be planned for a past day.',
      );
    if (daysBetween(today, scheduledFor) > VISIT.maxAheadDays)
      throw new BadRequestException(
        `Plan at most ${VISIT.maxAheadDays} days ahead.`,
      );
    const visit = await this.db.fieldVisit.create({
      data: {
        ...clean.value,
        organizationId: actor.organizationId,
        employeeId,
        createdById: actor.id,
        scheduledFor,
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'FIELD_VISIT_CREATED',
      module: 'EMPLOYEE',
      organizationId: actor.organizationId,
      targetId: visit.id,
      details: { employeeId, scheduledFor, client: visit.clientName },
    });
    if (employeeId !== actor.id) {
      try {
        await this.notifications.create({
          organizationId: actor.organizationId,
          userId: employeeId,
          title: 'New field visit',
          message: `${actor.name} planned a visit to ${visit.clientName} for you on ${scheduledFor}.`,
          category: NotificationCategory.ATTENDANCE,
        });
      } catch {
        /* a failed notice must not fail the plan */
      }
    }
    return visit;
  }

  private async scopeWhere(
    actor: Actor,
  ): Promise<{ employeeId?: { in: string[] } }> {
    if (actor.role === Role.EMPLOYEE) return { employeeId: { in: [actor.id] } };
    const scope = await reviewerScope(
      this.db,
      actor as never,
      actor.organizationId,
    );
    return scope ? { employeeId: { in: scope } } : {};
  }

  async list(
    actor: Actor,
    q: { from?: string; to?: string; employeeId?: string; status?: string },
  ) {
    await this.assertOn(actor.organizationId);
    const today = await this.today(actor.organizationId);
    const from = q.from && DATE.test(q.from) ? q.from : today;
    const to = q.to && DATE.test(q.to) ? q.to : from;
    if (to < from)
      throw new BadRequestException('The end date is before the start date.');
    if (daysBetween(from, to) > VISIT.maxRangeDays)
      throw new BadRequestException(
        `Choose at most ${VISIT.maxRangeDays} days.`,
      );
    const scope = await this.scopeWhere(actor);
    if (
      q.employeeId &&
      scope.employeeId &&
      !scope.employeeId.in.includes(q.employeeId)
    ) {
      throw new ForbiddenException(
        'You can only see visits of people you look after.',
      );
    }
    const status =
      q.status &&
      (Object.values(FieldVisitStatus) as string[]).includes(q.status)
        ? (q.status as FieldVisitStatus)
        : undefined;
    const rows = await this.db.fieldVisit.findMany({
      where: {
        organizationId: actor.organizationId,
        scheduledFor: { gte: from, lte: to },
        ...(q.employeeId ? { employeeId: q.employeeId } : scope),
        ...(status ? { status } : {}),
      },
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
      },
      orderBy: [{ scheduledFor: 'desc' }, { createdAt: 'asc' }],
      take: 2000,
    });
    return { from, to, visits: rows };
  }

  // The caller's own visits for a day (default today), plus any visit they are still checked in at.
  async mine(user: Actor, date?: string) {
    await this.assertOn(user.organizationId);
    const day =
      date && DATE.test(date) ? date : await this.today(user.organizationId);
    const rows = await this.db.fieldVisit.findMany({
      where: {
        organizationId: user.organizationId,
        employeeId: user.id,
        OR: [{ scheduledFor: day }, { status: FieldVisitStatus.CHECKED_IN }],
      },
      orderBy: [{ createdAt: 'asc' }],
    });
    return { date: day, visits: rows };
  }

  private async load(actor: Actor, id: string) {
    const v = await this.db.fieldVisit.findFirst({
      where: { id, organizationId: actor.organizationId },
    });
    if (!v) throw new NotFoundException('Visit not found.');
    return v;
  }

  // Edit a planned visit: its creator, or someone who looks after the employee.
  async update(actor: Actor, id: string, input: CreateVisitInput) {
    await this.assertOn(actor.organizationId);
    const v = await this.load(actor, id);
    if (v.status !== FieldVisitStatus.PLANNED)
      throw new BadRequestException('Only a planned visit can be changed.');
    if (!(await this.mayChange(actor, v)))
      throw new ForbiddenException('You cannot change this visit.');
    const clean = cleanVisitInput({
      clientName: input.clientName ?? v.clientName,
      address: input.address ?? v.address,
      latitude: input.latitude === undefined ? v.latitude : input.latitude,
      longitude: input.longitude === undefined ? v.longitude : input.longitude,
      radiusMeters: input.radiusMeters ?? v.radiusMeters,
      purpose: input.purpose ?? v.purpose,
    });
    if (!clean.ok) throw new BadRequestException(clean.reason);
    const today = await this.today(actor.organizationId);
    const scheduledFor =
      input.scheduledFor && DATE.test(input.scheduledFor)
        ? input.scheduledFor
        : v.scheduledFor;
    if (scheduledFor < today)
      throw new BadRequestException(
        'A visit cannot be planned for a past day.',
      );
    await this.db.fieldVisit.updateMany({
      where: {
        id,
        organizationId: actor.organizationId,
        status: FieldVisitStatus.PLANNED,
      },
      data: { ...clean.value, scheduledFor },
    });
    return this.load(actor, id);
  }

  async cancel(actor: Actor, id: string) {
    await this.assertOn(actor.organizationId);
    const v = await this.load(actor, id);
    if (v.status !== FieldVisitStatus.PLANNED)
      throw new BadRequestException('Only a planned visit can be cancelled.');
    if (!(await this.mayChange(actor, v)))
      throw new ForbiddenException('You cannot cancel this visit.');
    await this.db.fieldVisit.updateMany({
      where: {
        id,
        organizationId: actor.organizationId,
        status: FieldVisitStatus.PLANNED,
      },
      data: { status: FieldVisitStatus.CANCELLED },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'FIELD_VISIT_CANCELLED',
      module: 'EMPLOYEE',
      organizationId: actor.organizationId,
      targetId: id,
    });
    return this.load(actor, id);
  }

  // The employee arrives. Needs: their own visit, planned for today, and a punch-in. Far from the client = recorded and flagged.
  async checkIn(
    user: Actor,
    id: string,
    at: { latitude?: unknown; longitude?: unknown; accuracyMeters?: unknown },
  ) {
    await this.assertOn(user.organizationId);
    const v = await this.load(user, id);
    if (v.employeeId !== user.id)
      throw new ForbiddenException('You can only check in to your own visits.');
    if (v.status !== FieldVisitStatus.PLANNED) {
      throw new BadRequestException(
        v.status === FieldVisitStatus.CHECKED_IN
          ? 'You are already checked in to this visit.'
          : 'This visit can no longer be checked in to.',
      );
    }
    const lat = typeof at.latitude === 'number' ? at.latitude : NaN;
    const lng = typeof at.longitude === 'number' ? at.longitude : NaN;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      throw new BadRequestException('Your location is needed to check in.');
    const acc =
      typeof at.accuracyMeters === 'number' && at.accuracyMeters >= 0
        ? at.accuracyMeters
        : null;
    const today = await this.today(user.organizationId);
    if (v.scheduledFor !== today)
      throw new BadRequestException(
        v.scheduledFor > today
          ? 'This visit is planned for a later day.'
          : 'This visit was planned for an earlier day.',
      );
    if (!(await this.tracking.openShift(user.id, user.organizationId)))
      throw new BadRequestException(
        'Punch in first, then check in to the visit.',
      );
    const other = await this.db.fieldVisit.findFirst({
      where: {
        organizationId: user.organizationId,
        employeeId: user.id,
        status: FieldVisitStatus.CHECKED_IN,
      },
    });
    if (other)
      throw new ConflictException(`Check out of ${other.clientName} first.`);
    const verdict = assessCheckIn(
      {
        latitude: v.latitude,
        longitude: v.longitude,
        radiusMeters: v.radiusMeters,
      },
      { latitude: lat, longitude: lng, accuracyMeters: acc },
    );
    const res = await this.db.fieldVisit.updateMany({
      where: {
        id,
        organizationId: user.organizationId,
        status: FieldVisitStatus.PLANNED,
      },
      data: {
        status: FieldVisitStatus.CHECKED_IN,
        checkInAt: new Date(),
        checkInLatitude: lat,
        checkInLongitude: lng,
        checkInAccuracyMeters: acc,
        checkInDistanceMeters: verdict.distanceMeters,
        checkInWithinRange: verdict.withinRange,
      },
    });
    if (res.count === 0)
      throw new ConflictException(
        'This visit was just changed. Reload and try again.',
      );
    return this.load(user, id);
  }

  async checkOut(
    user: Actor,
    id: string,
    input: { latitude?: unknown; longitude?: unknown; outcome?: unknown },
  ) {
    await this.assertOn(user.organizationId);
    const v = await this.load(user, id);
    if (v.employeeId !== user.id)
      throw new ForbiddenException(
        'You can only check out of your own visits.',
      );
    if (v.status !== FieldVisitStatus.CHECKED_IN || !v.checkInAt)
      throw new BadRequestException('You are not checked in to this visit.');
    const now = new Date();
    const outcome =
      typeof input.outcome === 'string'
        ? input.outcome.trim().slice(0, 1000)
        : '';
    const res = await this.db.fieldVisit.updateMany({
      where: {
        id,
        organizationId: user.organizationId,
        status: FieldVisitStatus.CHECKED_IN,
      },
      data: {
        status: FieldVisitStatus.COMPLETED,
        checkOutAt: now,
        checkOutLatitude:
          typeof input.latitude === 'number' ? input.latitude : null,
        checkOutLongitude:
          typeof input.longitude === 'number' ? input.longitude : null,
        outcome,
        durationMinutes: visitMinutes(v.checkInAt, now),
      },
    });
    if (res.count === 0)
      throw new ConflictException(
        'This visit was just changed. Reload and try again.',
      );
    return this.load(user, id);
  }

  // Per person over a period: visits by outcome, time at clients, check-ins from outside the allowed distance, and distance
  // travelled (from the tracked points). People in the viewer's scope who are tracked or had a visit in the period.
  async report(actor: Actor, q: { from?: string; to?: string }) {
    await this.assertOn(actor.organizationId);
    if (actor.role === Role.EMPLOYEE)
      throw new ForbiddenException('Reports are for managers and HR.');
    const tz = await this.tz(actor.organizationId);
    const today = dateStrInOrgTz(tz, new Date());
    const to = q.to && DATE.test(q.to) ? q.to : today;
    const from = q.from && DATE.test(q.from) ? q.from : addDays(to, -6);
    if (to < from)
      throw new BadRequestException('The end date is before the start date.');
    if (daysBetween(from, to) > 31)
      throw new BadRequestException('Choose at most 31 days for the report.');
    const scope = await this.scopeWhere(actor);
    const [visits, tracked] = await Promise.all([
      this.db.fieldVisit.findMany({
        where: {
          organizationId: actor.organizationId,
          scheduledFor: { gte: from, lte: to },
          ...scope,
        },
      }),
      this.db.user.findMany({
        where: {
          organizationId: actor.organizationId,
          isActive: true,
          fieldTrackingEnabled: true,
          ...(scope.employeeId ? { id: scope.employeeId } : {}),
        },
        select: { id: true },
      }),
    ]);
    const ids = new Set<string>([
      ...tracked.map((t) => t.id),
      ...visits.map((v) => v.employeeId),
    ]);
    const people = await this.db.user.findMany({
      where: { organizationId: actor.organizationId, id: { in: [...ids] } },
      select: { id: true, name: true, employeeId: true, designation: true },
      orderBy: { name: 'asc' },
    });
    const range = {
      gte: dayRangeInOrgTz(from, tz).gte,
      lt: dayRangeInOrgTz(to, tz).lt,
    };
    const pings = ids.size
      ? await this.db.locationPing.findMany({
          where: {
            organizationId: actor.organizationId,
            employeeId: { in: [...ids] },
            kind: 'POINT',
            recordedAt: range,
            latitude: { not: null },
          },
          orderBy: { recordedAt: 'asc' },
          select: {
            employeeId: true,
            recordedAt: true,
            latitude: true,
            longitude: true,
          },
          take: 60_000,
        })
      : [];
    const byPersonDay = new Map<
      string,
      Map<string, { latitude: number; longitude: number; recordedAt: Date }[]>
    >();
    for (const p of pings) {
      const day = dateStrInOrgTz(tz, p.recordedAt);
      const days = byPersonDay.get(p.employeeId) ?? new Map();
      const list = days.get(day) ?? [];
      list.push({
        latitude: p.latitude as number,
        longitude: p.longitude as number,
        recordedAt: p.recordedAt,
      });
      days.set(day, list);
      byPersonDay.set(p.employeeId, days);
    }
    const rows = people.map((p) => {
      const mine = visits.filter((v) => v.employeeId === p.id);
      const days = byPersonDay.get(p.id) ?? new Map();
      let meters = 0;
      for (const list of days.values())
        meters += summarizeRoute(list).distanceMeters;
      return {
        ...p,
        ...summarizeVisits(mine),
        totalVisits: mine.length,
        daysTracked: days.size,
        distanceKm: Math.round(meters / 100) / 10,
      };
    });
    const totals = rows.reduce(
      (a, r) => ({
        completed: a.completed + r.completed,
        missed: a.missed + r.missed,
        minutesAtClients: a.minutesAtClients + r.minutesAtClients,
        distanceKm: Math.round((a.distanceKm + r.distanceKm) * 10) / 10,
        outsideRange: a.outsideRange + r.outsideRange,
      }),
      {
        completed: 0,
        missed: 0,
        minutesAtClients: 0,
        distanceKm: 0,
        outsideRange: 0,
      },
    );
    return { from, to, totals, people: rows };
  }

  // Every night: a planned visit whose day has passed is Missed; a visit still checked in after 20 hours is closed (no duration).
  @Cron('45 2 * * *')
  async closeStale() {
    try {
      const cutoffDay = addDays(new Date().toISOString().slice(0, 10), -2);
      const missed = await this.prisma.fieldVisit.updateMany({
        where: {
          status: FieldVisitStatus.PLANNED,
          scheduledFor: { lte: cutoffDay },
        },
        data: { status: FieldVisitStatus.MISSED },
      });
      const stale = await this.prisma.fieldVisit.updateMany({
        where: {
          status: FieldVisitStatus.CHECKED_IN,
          checkInAt: {
            lt: new Date(Date.now() - VISIT.staleCheckInHours * 3_600_000),
          },
        },
        data: { status: FieldVisitStatus.COMPLETED, autoClosed: true },
      });
      if (missed.count || stale.count)
        this.logger.log(
          `Field visits: ${missed.count} marked missed, ${stale.count} auto-closed.`,
        );
    } catch (e) {
      this.logger.error(
        `Closing stale field visits failed: ${(e as Error).message}`,
      );
    }
  }
}
