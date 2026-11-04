import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { FieldTrackingService } from './field-tracking.service';
import { registerModuleGate } from '../module-access/module-gate';

const NOW = Date.now();
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function build(
  opts: {
    shifts?: { inTime: Date; outTime: Date | null }[];
    people?: Record<string, unknown>[];
    turnedOff?: number;
    planned?: number;
    open?: number;
  } = {},
) {
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const notes: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const visitUpdates: Record<string, unknown>[] = [];
  const db = {
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    attendance: {
      findMany: async () => opts.shifts ?? [],
      findFirst: async () =>
        (opts.shifts ?? []).find((s) => s.outTime === null) ?? null,
    },
    locationPing: {
      createMany: async (a: { data: Record<string, unknown>[] }) => {
        created.push(...a.data);
        return { count: a.data.length };
      },
      findMany: async () => [],
    },
    user: {
      findMany: async () => opts.people ?? [],
      findFirst: async () => ({ id: 'e1', name: 'Asha', employeeId: 'E1' }),
      updateMany: async (a: Record<string, unknown>) => {
        updates.push(a);
        return { count: opts.turnedOff ?? 1 };
      },
    },
    fieldVisit: {
      updateMany: async (a: { where: { status: string } }) => {
        visitUpdates.push(a as never);
        return {
          count:
            a.where.status === 'PLANNED'
              ? (opts.planned ?? 0)
              : (opts.open ?? 0),
        };
      },
    },
  };
  const svc = new FieldTrackingService(
    db as never,
    {} as never,
    {
      log: async (a: Record<string, unknown>) => {
        audits.push(a);
      },
    } as never,
    {
      create: async (a: Record<string, unknown>) => {
        notes.push(a);
      },
    } as never,
  );
  return { svc, created, updates, notes, audits, visitUpdates };
}

const user = (o: Record<string, unknown> = {}) =>
  ({
    id: 'e1',
    name: 'Asha',
    role: Role.EMPLOYEE,
    organizationId: 'org',
    fieldTrackingEnabled: true,
    fieldTrackingConsentAt: new Date(),
    ...o,
  }) as never;
const good = (minAgo: number) => ({
  recordedAt: iso(minAgo),
  latitude: 19.07,
  longitude: 72.87,
  accuracyMeters: 10,
});

describe('field tracking: sending points', () => {
  it('is refused when tracking is off for the person or they have not agreed', async () => {
    const { svc } = build();
    await expect(
      svc.ingest(user({ fieldTrackingEnabled: false }), [good(1)]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.ingest(user({ fieldTrackingConsentAt: null }), [good(1)]),
    ).rejects.toThrow(/agree/);
    await expect(svc.ingest(user(), [])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('keeps points inside the shift and refuses the rest with reasons', async () => {
    const { svc, created } = build({
      shifts: [{ inTime: new Date(NOW - 120 * 60_000), outTime: null }],
    });
    const res = await svc.ingest(user(), [
      good(10),
      good(30),
      { recordedAt: iso(300), latitude: 19, longitude: 72 },
      { recordedAt: iso(5), latitude: 999, longitude: 1 },
    ]);
    expect(res.accepted).toBe(2);
    expect(res.rejected).toEqual({ 'outside shift': 1, 'bad coordinates': 1 });
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      organizationId: 'org',
      employeeId: 'e1',
    });
  });
  it('accepts a queued point from before punch-out but not after it', async () => {
    const { svc } = build({
      shifts: [
        {
          inTime: new Date(NOW - 300 * 60_000),
          outTime: new Date(NOW - 60 * 60_000),
        },
      ],
    });
    const res = await svc.ingest(user(), [good(120), good(30)]);
    expect(res.accepted).toBe(1);
  });
});

describe('field tracking: choosing who is tracked', () => {
  const admin = user({ id: 'a1', role: Role.ADMIN, name: 'Admin' });
  it('turning it on resets consent, tells the person and audits; people already on are left', async () => {
    const { svc, updates, notes, audits } = build({
      people: [
        { id: 'p1', name: 'P1', fieldTrackingEnabled: false },
        { id: 'p2', name: 'P2', fieldTrackingEnabled: true },
      ],
    });
    const res = await svc.setEnabled(admin, ['p1', 'p2', 'ghost'], true);
    expect(res).toEqual({ changed: 1, unchanged: 1, notFound: 1 });
    expect((updates[0] as { data: unknown }).data).toEqual({
      fieldTrackingEnabled: true,
      fieldTrackingConsentAt: null,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      userId: 'p1',
      title: 'Live tracking turned on',
    });
    expect(audits[0]).toMatchObject({ action: 'FIELD_TRACKING_ENABLED' });
  });
  it('turning it off keeps it quiet', async () => {
    const { svc, notes, audits } = build({
      people: [{ id: 'p1', name: 'P1', fieldTrackingEnabled: true }],
    });
    await svc.setEnabled(admin, ['p1'], false);
    expect(notes).toHaveLength(0);
    expect(audits[0]).toMatchObject({ action: 'FIELD_TRACKING_DISABLED' });
  });
});

describe('field tracking: who can see a trail', () => {
  it("an employee can see their own but not someone else's", async () => {
    const { svc, audits } = build();
    await expect(svc.route(user(), 'e1', '2026-11-05')).resolves.toMatchObject({
      date: '2026-11-05',
      points: [],
    });
    expect(audits).toHaveLength(0); // looking at your own trail is not audited
    // ...it says how long points are kept (so the day picker can stop there), and it still works after tracking is switched off,
    // because the person is entitled to see what was recorded about them until it is deleted.
    await expect(
      svc.route(user({ fieldTrackingEnabled: false }), 'e1', '2026-11-05'),
    ).resolves.toMatchObject({ retentionDays: 60 });
    await expect(
      svc.route(user(), 'other', '2026-11-05'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('an Admin looking at someone else is audited', async () => {
    const { svc, audits } = build();
    await svc.route(user({ id: 'a1', role: Role.ADMIN }), 'e1', '2026-11-05');
    expect(audits[0]).toMatchObject({
      action: 'FIELD_TRACKING_ROUTE_VIEWED',
      targetId: 'e1',
    });
  });
});

describe('field tracking: retention', () => {
  it("deletes each company's samples past that company's own retention period (60 days unless changed), and never throws", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 3 });
    const svc = new FieldTrackingService(
      {} as never,
      {
        organization: {
          findMany: async () => [
            { id: 'a', fieldTrackingSettings: null },
            { id: 'b', fieldTrackingSettings: { retentionDays: 30 } },
            { id: 'c', fieldTrackingSettings: { retentionDays: 30 } },
          ],
        },
        locationPing: { deleteMany },
      } as never,
      {} as never,
      {} as never,
    );
    await svc.purgeOld();
    type Call = {
      where: { organizationId: { in: string[] }; recordedAt: { lt: Date } };
    };
    const calls = deleteMany.mock.calls.map((c) => c[0] as Call);
    const daysFor = (orgs: string[]) => {
      const c = calls.find(
        (x) => x.where.organizationId.in.join() === orgs.join(),
      );
      return (Date.now() - c!.where.recordedAt.lt.getTime()) / 86_400_000;
    };
    expect(calls).toHaveLength(2);
    expect(daysFor(['a'])).toBeGreaterThan(59.9);
    expect(daysFor(['a'])).toBeLessThan(60.1);
    expect(daysFor(['b', 'c'])).toBeGreaterThan(29.9);
    expect(daysFor(['b', 'c'])).toBeLessThan(30.1);
    const broken = new FieldTrackingService(
      {} as never,
      {
        organization: {
          findMany: jest.fn().mockRejectedValue(new Error('db down')),
        },
      } as never,
      {} as never,
      {} as never,
    );
    await expect(broken.purgeOld()).resolves.toBeUndefined();
  });
});

describe('field tracking: company settings', () => {
  const withOrg = (stored: unknown) => {
    const updates: unknown[] = [];
    const audits: Record<string, unknown>[] = [];
    const svc = new FieldTrackingService(
      {
        organization: {
          findFirst: async () => ({ fieldTrackingSettings: stored }),
          updateMany: async (a: unknown) => {
            updates.push(a);
            return { count: 1 };
          },
        },
      } as never,
      {} as never,
      {
        log: async (a: Record<string, unknown>) => {
          audits.push(a);
        },
      } as never,
      {} as never,
    );
    return { svc, updates, audits };
  };
  const admin = { id: 'a1', role: Role.ADMIN, organizationId: 'org' } as never;

  it('uses the built-in defaults until a company changes them', async () => {
    const { svc } = withOrg(null);
    expect(await svc.getSettings('org')).toEqual({
      intervalSeconds: 300,
      minDistanceMeters: 200,
      retentionDays: 60,
    });
  });

  it('saves valid values and audits the before and after', async () => {
    registerModuleGate({ featureEnabledFor: async () => true } as never);
    try {
      const { svc, updates, audits } = withOrg(null);
      const out = await svc.updateSettings(admin, {
        intervalSeconds: 600,
        minDistanceMeters: 300,
        retentionDays: 90,
      });
      expect(out).toEqual({
        intervalSeconds: 600,
        minDistanceMeters: 300,
        retentionDays: 90,
      });
      expect(updates).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'FIELD_TRACKING_SETTINGS_CHANGED',
        details: {
          intervalSeconds: { from: 300, to: 600 },
          minDistanceMeters: { from: 200, to: 300 },
          retentionDays: { from: 60, to: 90 },
        },
      });
    } finally {
      registerModuleGate(null as never);
    }
  });

  it('refuses values outside the allowed range and saves nothing', async () => {
    registerModuleGate({ featureEnabledFor: async () => true } as never);
    try {
      const { svc, updates } = withOrg(null);
      await expect(
        svc.updateSettings(admin, {
          intervalSeconds: 30,
          minDistanceMeters: 300,
          retentionDays: 5000,
        }),
      ).rejects.toThrow(/Sharing interval.*Keep points for/);
      expect(updates).toHaveLength(0);
    } finally {
      registerModuleGate(null as never);
    }
  });
});

describe('field tracking: stopping when the reason ends', () => {
  it('a leaver is switched off, their planned visits cancelled and an open check-in closed, with one audit entry', async () => {
    const { svc, updates, audits, visitUpdates, notes } = build({
      planned: 3,
      open: 1,
    });
    const did = await svc.stopForChange('org', 'e1', 'left_company', 'hr', {
      closeVisits: true,
    });
    expect(did).toBe(true);
    expect((updates[0] as { data: unknown }).data).toEqual({
      fieldTrackingEnabled: false,
    });
    expect(visitUpdates).toHaveLength(2);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'FIELD_TRACKING_DISABLED',
      details: {
        reason: 'left_company',
        visitsCancelled: 3,
        visitsClosed: 1,
      },
    });
    // A leaver is not sent a notice.
    expect(notes).toHaveLength(0);
  });

  it('a department change switches it off and tells the person; visits are left alone', async () => {
    const { svc, notes, visitUpdates } = build();
    const did = await svc.stopForChange(
      'org',
      'e1',
      'department_changed',
      'hr',
      {
        tellPerson: true,
      },
    );
    expect(did).toBe(true);
    expect(visitUpdates).toHaveLength(0);
    expect(notes).toHaveLength(1);
    expect(String(notes[0].message)).toMatch(/department changed/i);
  });

  it('is quiet when tracking was already off and nothing was pending', async () => {
    const { svc, audits, notes } = build({ turnedOff: 0 });
    const did = await svc.stopForChange('org', 'e1', 'role_changed', 'hr', {
      closeVisits: true,
      tellPerson: true,
    });
    expect(did).toBe(false);
    expect(audits).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });
});
