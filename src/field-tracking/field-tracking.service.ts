// Purpose: Live tracking of field employees - who is tracked, the phone's location samples, and the live map / day route.
// Responsibilities: switch tracking on or off per person (Admin / HR) and tell the person; record the person's consent;
//   accept samples from their phone only during a shift; give managers / HR the live view and a day's route within the
//   people they look after; delete samples after the retention period; audit every look at someone's location.
// Important: the company must have the feature on (Control Panel > Organization > Features); a person is tracked only if
//   Admin / HR switched it on for them AND they consented, and only between punch-in and punch-out. Employees see their own
//   trail; managers only their reporting line (same scope as approvals); HR / Admin as scoped elsewhere.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
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
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { featureEnabledFor } from '../module-access/module-gate';
import { inReviewerScope, reviewerScope } from '../common/dept-scope';
import { dateStrInOrgTz, dayRangeInOrgTz } from '../common/org-date';
import {
  cleanPing,
  deriveStatus,
  offlineAfterMinutesFor,
  resolveTrackingSettings,
  summarizeRoute,
  TRACKING,
  validateTrackingSettingsInput,
  type CleanPing,
  type RawPing,
} from './field-tracking-logic';

export const FIELD_TRACKING_FLAG = 'feature.field_tracking';

type Actor = Pick<User, 'id' | 'role' | 'organizationId' | 'name'> &
  Partial<User>;

@Injectable()
export class FieldTrackingService {
  private readonly logger = new Logger(FieldTrackingService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: ExtendedPrismaClient,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly notifications: NotificationsService,
    // Optional so tests that build this service by hand keep working.
    @Optional() private readonly timeline?: EmployeeTimelineService,
  ) {}

  private async featureOn(organizationId: string): Promise<boolean> {
    return featureEnabledFor(organizationId, FIELD_TRACKING_FLAG);
  }

  private async assertOn(organizationId: string) {
    if (!(await this.featureOn(organizationId))) {
      throw new ForbiddenException(
        'Live tracking is not switched on for this company.',
      );
    }
  }

  private async orgTimezone(organizationId: string): Promise<string> {
    const org = await this.db.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone || 'Asia/Kolkata';
  }

  // The shift the person is in right now: a punch-in with no punch-out (within the last 36 hours, for night shifts).
  async openShift(
    employeeId: string,
    organizationId: string,
    now = new Date(),
  ) {
    return this.db.attendance.findFirst({
      where: {
        organizationId,
        employeeId,
        inTime: {
          not: null,
          gte: new Date(now.getTime() - TRACKING.maxAgeHours * 3_600_000),
        },
        outTime: null,
      },
      orderBy: { inTime: 'desc' },
      select: { inTime: true, outTime: true },
    });
  }

  // The employee's timeline gets a line when tracking is switched on or off for them. Never fails the change itself.
  private async timelineNote(
    organizationId: string,
    employeeId: string,
    enabled: boolean,
    actorId: string,
    remarks?: string,
  ) {
    try {
      await this.timeline?.logEvent({
        organizationId,
        employeeId,
        eventKey: enabled
          ? 'FIELD_TRACKING_ENABLED'
          : 'FIELD_TRACKING_DISABLED',
        performedById: actorId,
        ...(remarks ? { remarks } : {}),
      });
    } catch {
      /* a missing timeline line must not undo the change */
    }
  }

  // The company's own settings (interval, early-point distance, retention days); the built-in defaults until changed.
  async getSettings(organizationId: string) {
    const org = await this.db.organization.findFirst({
      where: { id: organizationId },
      select: { fieldTrackingSettings: true },
    });
    return resolveTrackingSettings(org?.fieldTrackingSettings);
  }

  // Admin / HR change them. Out-of-range values are refused with the reasons, not quietly adjusted. Phones pick the new
  // interval up the next time they read their status (within minutes); a shorter retention takes effect at the next nightly clean-up.
  async updateSettings(actor: Actor, input: unknown) {
    await this.assertOn(actor.organizationId);
    const { settings, errors } = validateTrackingSettingsInput(input);
    if (!settings) throw new BadRequestException(errors.join(' '));
    const before = await this.getSettings(actor.organizationId);
    await this.db.organization.updateMany({
      where: { id: actor.organizationId },
      data: { fieldTrackingSettings: { ...settings } },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'FIELD_TRACKING_SETTINGS_CHANGED',
      module: 'ORGANIZATION',
      organizationId: actor.organizationId,
      targetId: actor.organizationId,
      // Each setting that changed as { from, to }, which the audit screen prints as "300 → 600".
      details: Object.fromEntries(
        (Object.keys(settings) as (keyof typeof settings)[])
          .filter((k) => settings[k] !== before[k])
          .map((k) => [k, { from: before[k], to: settings[k] }]),
      ),
    });
    return settings;
  }

  // What the phone needs to know: is tracking on for me, did I consent, am I on shift, and how to sample.
  async status(user: Actor) {
    const featureOn = await this.featureOn(user.organizationId);
    const cfg = featureOn
      ? await this.getSettings(user.organizationId)
      : resolveTrackingSettings(null);
    const base = {
      featureOn,
      enabled: !!user.fieldTrackingEnabled,
      consented: !!user.fieldTrackingConsentAt,
      intervalSeconds: cfg.intervalSeconds,
      minDistanceMeters: cfg.minDistanceMeters,
      retentionDays: cfg.retentionDays,
    };
    if (!featureOn || !user.fieldTrackingEnabled)
      return { ...base, shiftActive: false };
    const open = await this.openShift(user.id, user.organizationId);
    return { ...base, shiftActive: !!open };
  }

  async consent(user: Actor) {
    await this.assertOn(user.organizationId);
    if (!user.fieldTrackingEnabled) {
      throw new BadRequestException(
        'Live tracking has not been switched on for you.',
      );
    }
    await this.db.user.updateMany({
      where: { id: user.id, organizationId: user.organizationId },
      data: { fieldTrackingConsentAt: new Date() },
    });
    await this.audit.log({
      actorId: user.id,
      action: 'FIELD_TRACKING_CONSENT_GIVEN',
      module: 'EMPLOYEE',
      organizationId: user.organizationId,
      targetId: user.id,
    });
    return { consented: true };
  }

  // Admin / HR choose who is tracked. Turning it on tells the person; turning it on again after it was off asks for a
  // fresh consent. Returns how many people changed.
  async setEnabled(actor: Actor, employeeIds: string[], enabled: boolean) {
    await this.assertOn(actor.organizationId);
    const people = await this.db.user.findMany({
      where: {
        organizationId: actor.organizationId,
        id: { in: [...new Set(employeeIds)] },
        isActive: true,
      },
      select: { id: true, name: true, fieldTrackingEnabled: true },
    });
    const changing = people.filter((p) => p.fieldTrackingEnabled !== enabled);
    if (changing.length) {
      await this.db.user.updateMany({
        where: {
          organizationId: actor.organizationId,
          id: { in: changing.map((p) => p.id) },
        },
        data: enabled
          ? { fieldTrackingEnabled: true, fieldTrackingConsentAt: null }
          : { fieldTrackingEnabled: false },
      });
      await this.audit.log({
        actorId: actor.id,
        action: enabled ? 'FIELD_TRACKING_ENABLED' : 'FIELD_TRACKING_DISABLED',
        module: 'EMPLOYEE',
        organizationId: actor.organizationId,
        targetId: actor.id,
        details: {
          employeeIds: changing.map((p) => p.id),
          count: changing.length,
        },
      });
      for (const p of changing)
        await this.timelineNote(actor.organizationId, p.id, enabled, actor.id);
      if (enabled) {
        for (const p of changing) {
          try {
            await this.notifications.create({
              organizationId: actor.organizationId,
              userId: p.id,
              title: 'Live tracking turned on',
              message:
                'Your company turned on live tracking for you. During your shift (from punch-in to punch-out) the app shares your location. Open the app to review and agree.',
              category: NotificationCategory.ATTENDANCE,
            });
          } catch {
            /* a failed notice must not fail the change */
          }
        }
      }
    }
    return {
      changed: changing.length,
      unchanged: people.length - changing.length,
      notFound: employeeIds.length - people.length,
    };
  }

  // Tracking stops by itself when the reason for it ends: the person leaves the company, or moves to another department or
  // role (a field employee who moves to an office desk should not stay tracked). Their saved trail and past visits stay until
  // the 60-day clean-up; only the switch is turned off. For a leaver, visits that never happened are cancelled and a
  // check-in still open is closed, so nothing stays pending against someone who is gone. Quiet when tracking was already off.
  async stopForChange(
    organizationId: string,
    employeeId: string,
    reason: 'left_company' | 'department_changed' | 'role_changed',
    actorId: string,
    opts: { closeVisits?: boolean; tellPerson?: boolean } = {},
  ): Promise<boolean> {
    const turnedOff = await this.db.user.updateMany({
      where: { id: employeeId, organizationId, fieldTrackingEnabled: true },
      data: { fieldTrackingEnabled: false },
    });
    let cancelled = 0;
    let closed = 0;
    if (opts.closeVisits) {
      const planned = await this.db.fieldVisit.updateMany({
        where: {
          organizationId,
          employeeId,
          status: FieldVisitStatus.PLANNED,
        },
        data: { status: FieldVisitStatus.CANCELLED },
      });
      const open = await this.db.fieldVisit.updateMany({
        where: {
          organizationId,
          employeeId,
          status: FieldVisitStatus.CHECKED_IN,
        },
        data: { status: FieldVisitStatus.COMPLETED, autoClosed: true },
      });
      cancelled = planned.count;
      closed = open.count;
    }
    if (turnedOff.count === 0 && cancelled === 0 && closed === 0) return false;
    await this.audit.log({
      actorId,
      action: 'FIELD_TRACKING_DISABLED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: employeeId,
      details: {
        employeeIds: [employeeId],
        count: turnedOff.count,
        reason,
        visitsCancelled: cancelled,
        visitsClosed: closed,
      },
    });
    if (turnedOff.count)
      await this.timelineNote(
        organizationId,
        employeeId,
        false,
        actorId,
        reason === 'left_company'
          ? 'Employee left the company'
          : reason === 'department_changed'
            ? 'Department changed'
            : 'Role changed',
      );
    if (turnedOff.count && opts.tellPerson) {
      try {
        await this.notifications.create({
          organizationId,
          userId: employeeId,
          title: 'Live tracking turned off',
          message:
            reason === 'department_changed'
              ? 'Your department changed, so live tracking was turned off. HR can turn it on again if your new role needs it.'
              : 'Your role changed, so live tracking was turned off. HR can turn it on again if your new role needs it.',
          category: NotificationCategory.ATTENDANCE,
        });
      } catch {
        /* a failed notice must not fail the change */
      }
    }
    return turnedOff.count > 0;
  }

  // The phone's samples. Only a person with tracking on and consent, and only for times they were punched in.
  async ingest(user: Actor, raws: RawPing[]) {
    await this.assertOn(user.organizationId);
    if (!user.fieldTrackingEnabled)
      throw new ForbiddenException('Live tracking is not switched on for you.');
    if (!user.fieldTrackingConsentAt)
      throw new ForbiddenException(
        'Please agree to live tracking in the app first.',
      );
    if (!Array.isArray(raws) || raws.length === 0)
      throw new BadRequestException('Send at least one point.');
    if (raws.length > TRACKING.maxBatch)
      throw new BadRequestException(
        `Send at most ${TRACKING.maxBatch} points at a time.`,
      );
    const now = new Date();
    const shifts = await this.db.attendance.findMany({
      where: {
        organizationId: user.organizationId,
        employeeId: user.id,
        inTime: {
          not: null,
          gte: new Date(now.getTime() - TRACKING.maxAgeHours * 3_600_000),
        },
      },
      select: { inTime: true, outTime: true },
    });
    const withinShift = (t: Date) =>
      shifts.some(
        (s) =>
          s.inTime &&
          t >= s.inTime &&
          t <=
            (s.outTime ??
              new Date(now.getTime() + TRACKING.futureSkewMinutes * 60_000)),
      );
    const accepted: CleanPing[] = [];
    const rejected: Record<string, number> = {};
    const reject = (r: string) => (rejected[r] = (rejected[r] ?? 0) + 1);
    for (const raw of raws) {
      const c = cleanPing(raw, now);
      if (!c.ok) {
        reject(c.reason);
        continue;
      }
      if (!withinShift(c.ping.recordedAt)) {
        reject('outside shift');
        continue;
      }
      accepted.push(c.ping);
    }
    if (accepted.length) {
      await this.db.locationPing.createMany({
        data: accepted.map((p) => ({
          ...p,
          organizationId: user.organizationId,
          employeeId: user.id,
        })),
        skipDuplicates: true,
      });
    }
    return { accepted: accepted.length, rejected };
  }

  // The live view for the people the caller looks after (Admin: everyone tracked).
  async live(actor: Actor, recordView = true) {
    await this.assertOn(actor.organizationId);
    const scope = await reviewerScope(
      this.db,
      actor as never,
      actor.organizationId,
    );
    const tracked = await this.db.user.findMany({
      where: {
        organizationId: actor.organizationId,
        isActive: true,
        fieldTrackingEnabled: true,
        ...(scope ? { id: { in: scope } } : {}),
      },
      select: {
        id: true,
        employeeId: true,
        name: true,
        designation: true,
        fieldTrackingConsentAt: true,
        department: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });
    const now = new Date();
    const cfg = await this.getSettings(actor.organizationId);
    const offlineAfterMinutes = offlineAfterMinutesFor(cfg.intervalSeconds);
    const ids = tracked.map((t) => t.id);
    const since = new Date(now.getTime() - TRACKING.maxAgeHours * 3_600_000);
    const [lastAny, recentPoints, shifts] = ids.length
      ? await Promise.all([
          this.db.locationPing.findMany({
            where: {
              organizationId: actor.organizationId,
              employeeId: { in: ids },
              recordedAt: { gte: since },
            },
            orderBy: [{ employeeId: 'asc' }, { recordedAt: 'desc' }],
            distinct: ['employeeId'],
          }),
          this.db.locationPing.findMany({
            where: {
              organizationId: actor.organizationId,
              employeeId: { in: ids },
              kind: 'POINT',
              recordedAt: { gte: since },
            },
            orderBy: { recordedAt: 'desc' },
            take: ids.length * 3,
          }),
          this.db.attendance.findMany({
            where: {
              organizationId: actor.organizationId,
              employeeId: { in: ids },
              inTime: { not: null, gte: since },
              outTime: null,
            },
            select: { employeeId: true },
          }),
        ])
      : [[], [], []];
    const onShift = new Set(shifts.map((s) => s.employeeId));
    const lastBy = new Map(lastAny.map((p) => [p.employeeId, p]));
    const pointsBy = new Map<string, typeof recentPoints>();
    for (const p of recentPoints) {
      const l = pointsBy.get(p.employeeId) ?? [];
      if (l.length < 2) l.push(p);
      pointsBy.set(p.employeeId, l);
    }
    const employees = tracked.map((t) => {
      const last = lastBy.get(t.id) ?? null;
      const pts = (pointsBy.get(t.id) ?? []).filter(
        (p) => p.latitude !== null && p.longitude !== null,
      );
      const newest = pts[0] ?? null;
      const status = t.fieldTrackingConsentAt
        ? deriveStatus({
            offlineAfterMinutes,
            onShift: onShift.has(t.id),
            now,
            last: last
              ? { kind: last.kind, recordedAt: last.recordedAt }
              : null,
            points: pts.map((p) => ({
              latitude: p.latitude as number,
              longitude: p.longitude as number,
              recordedAt: p.recordedAt,
              speedMps: p.speedMps,
            })),
          })
        : ('NO_CONSENT' as const);
      return {
        id: t.id,
        employeeId: t.employeeId,
        name: t.name,
        designation: t.designation,
        department: t.department?.name ?? null,
        status,
        onShift: onShift.has(t.id),
        consented: !!t.fieldTrackingConsentAt,
        lastSeenAt: last?.recordedAt ?? null,
        latitude: newest?.latitude ?? null,
        longitude: newest?.longitude ?? null,
        accuracyMeters: newest?.accuracyMeters ?? null,
        batteryPercent: last?.batteryPercent ?? null,
        locationAt: newest?.recordedAt ?? null,
        isMock: newest?.isMock ?? false,
      };
    });
    if (recordView) {
      await this.audit.log({
        actorId: actor.id,
        action: 'FIELD_TRACKING_LIVE_VIEWED',
        module: 'EMPLOYEE',
        organizationId: actor.organizationId,
        targetId: actor.id,
        details: { people: employees.length },
      });
    }
    return {
      generatedAt: now,
      intervalSeconds: cfg.intervalSeconds,
      employees,
    };
  }

  // Head-counts only, for the dashboard tile: how many of the people the caller looks after are on the move, standing, out of
  // signal or have location off, and how today's client visits stand. No names or places, so reading it is not a look at anyone's
  // location and is not written to the audit log (the full live view is).
  async summary(actor: Actor) {
    const view = await this.live(actor, false);
    const count = (st: string) =>
      view.employees.filter((e) => e.status === st).length;
    const scope = await reviewerScope(
      this.db,
      actor as never,
      actor.organizationId,
    );
    const today = dateStrInOrgTz(
      await this.orgTimezone(actor.organizationId),
      new Date(),
    );
    const visits = await this.db.fieldVisit.groupBy({
      by: ['status'],
      where: {
        organizationId: actor.organizationId,
        scheduledFor: today,
        ...(scope ? { employeeId: { in: scope } } : {}),
      },
      _count: { _all: true },
    });
    const v = (st: string) =>
      visits.find((x) => x.status === st)?._count._all ?? 0;
    return {
      tracked: view.employees.length,
      onShift: view.employees.filter((e) => e.onShift).length,
      moving: count('MOVING'),
      stationary: count('STATIONARY'),
      offline: count('OFFLINE'),
      locationOff: count('LOCATION_OFF'),
      awaitingConsent: count('NO_CONSENT'),
      visitsToday: {
        planned: v('PLANNED'),
        checkedIn: v('CHECKED_IN'),
        completed: v('COMPLETED'),
        missed: v('MISSED'),
      },
    };
  }

  // One person's day: the points in order, distance travelled and the places they stayed. Self, or someone the caller looks after.
  async route(actor: Actor, employeeId: string, date?: string) {
    await this.assertOn(actor.organizationId);
    const self = actor.id === employeeId;
    if (!self) {
      if (actor.role === Role.EMPLOYEE)
        throw new ForbiddenException('You can only see your own trail.');
      if (
        !(await inReviewerScope(
          this.db,
          actor as never,
          actor.organizationId,
          employeeId,
        ))
      ) {
        throw new ForbiddenException('You can only see people you look after.');
      }
    }
    const person = await this.db.user.findFirst({
      where: { id: employeeId, organizationId: actor.organizationId },
      select: { id: true, name: true, employeeId: true },
    });
    if (!person) throw new BadRequestException('Employee not found.');
    const tz = await this.orgTimezone(actor.organizationId);
    const day =
      date && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : dateStrInOrgTz(tz, new Date());
    const range = dayRangeInOrgTz(day, tz);
    const rows = await this.db.locationPing.findMany({
      where: {
        organizationId: actor.organizationId,
        employeeId,
        recordedAt: { gte: range.gte, lt: range.lt },
      },
      orderBy: { recordedAt: 'asc' },
    });
    const points = rows
      .filter(
        (r) =>
          r.kind === 'POINT' && r.latitude !== null && r.longitude !== null,
      )
      .map((r) => ({
        latitude: r.latitude as number,
        longitude: r.longitude as number,
        recordedAt: r.recordedAt,
        accuracyMeters: r.accuracyMeters,
        batteryPercent: r.batteryPercent,
        isMock: r.isMock,
      }));
    const gaps = rows
      .filter((r) => r.kind === 'LOCATION_OFF')
      .map((r) => r.recordedAt);
    const summary = summarizeRoute(points);
    if (!self) {
      await this.audit.log({
        actorId: actor.id,
        action: 'FIELD_TRACKING_ROUTE_VIEWED',
        module: 'EMPLOYEE',
        organizationId: actor.organizationId,
        targetId: employeeId,
        details: { date: day },
      });
    }
    return {
      employee: person,
      date: day,
      points,
      locationOffAt: gaps,
      distanceKm: Math.round(summary.distanceMeters / 100) / 10,
      stops: summary.stops,
      firstSeenAt: points[0]?.recordedAt ?? null,
      lastSeenAt: points[points.length - 1]?.recordedAt ?? null,
    };
  }

  // Samples older than each company's retention period (60 days unless the company changed it) are deleted every night.
  @Cron('15 3 * * *')
  async purgeOld() {
    try {
      const orgs = await this.prisma.organization.findMany({
        select: { id: true, fieldTrackingSettings: true },
      });
      const byDays = new Map<number, string[]>();
      for (const o of orgs) {
        const days = resolveTrackingSettings(
          o.fieldTrackingSettings,
        ).retentionDays;
        byDays.set(days, [...(byDays.get(days) ?? []), o.id]);
      }
      let deleted = 0;
      for (const [days, ids] of byDays) {
        const res = await this.prisma.locationPing.deleteMany({
          where: {
            organizationId: { in: ids },
            recordedAt: { lt: new Date(Date.now() - days * 86_400_000) },
          },
        });
        deleted += res.count;
      }
      if (deleted)
        this.logger.log(
          `Deleted ${deleted} location samples past their company's retention period.`,
        );
    } catch (e) {
      this.logger.error(`Location purge failed: ${(e as Error).message}`);
    }
  }
}
