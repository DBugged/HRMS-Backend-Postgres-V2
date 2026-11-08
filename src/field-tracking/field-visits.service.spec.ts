import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { FieldVisitsService } from './field-visits.service';
import { dateStrInOrgTz } from '../common/org-date';

const TODAY = dateStrInOrgTz('Asia/Kolkata', new Date());
const refuse = (op: string) => () => {
  throw new Error(`FieldVisit.${op}: not allowed on a tenant-scoped model`);
};

function build(
  opts: {
    visits?: Record<string, unknown>[];
    shift?: boolean;
    person?: Record<string, unknown> | null;
  } = {},
) {
  const visits = (opts.visits ?? []).map((v) => ({ ...v }));
  const notes: Record<string, unknown>[] = [];
  const db = {
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    user: {
      findFirst: async () =>
        opts.person === undefined
          ? { id: 'e1', name: 'Asha', fieldTrackingEnabled: true }
          : opts.person,
    },
    fieldVisit: {
      create: async (a: { data: Record<string, unknown> }) => {
        const row = {
          id: `v${visits.length + 1}`,
          status: 'PLANNED',
          ...a.data,
        };
        visits.push(row);
        return row;
      },
      findFirst: async (a: { where: Record<string, unknown> }) =>
        visits.find((v) =>
          Object.entries(a.where).every(
            ([k, w]) => k === 'organizationId' || v[k] === w,
          ),
        ) ?? null,
      updateMany: async (a: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        const v = visits.find(
          (x) =>
            x.id === a.where.id &&
            (!a.where.status || x.status === a.where.status),
        );
        if (!v) return { count: 0 };
        Object.assign(v, a.data);
        return { count: 1 };
      },
      update: refuse('update'),
      delete: refuse('delete'),
    },
  };
  const svc = new FieldVisitsService(
    db as never,
    {} as never,
    { log: async () => undefined } as never,
    {
      create: async (n: Record<string, unknown>) => {
        notes.push(n);
      },
    } as never,
    {
      openShift: async () =>
        opts.shift === false ? null : { inTime: new Date(), outTime: null },
    } as never,
  );
  return { svc, visits, notes };
}

const emp = {
  id: 'e1',
  name: 'Asha',
  role: Role.EMPLOYEE,
  organizationId: 'org',
} as never;
const admin = {
  id: 'a1',
  name: 'Admin',
  role: Role.ADMIN,
  organizationId: 'org',
} as never;
const planned = (o: Record<string, unknown> = {}) => ({
  id: 'v1',
  employeeId: 'e1',
  createdById: 'a1',
  clientName: 'Acme',
  latitude: 19.07,
  longitude: 72.87,
  radiusMeters: 150,
  scheduledFor: TODAY,
  status: 'PLANNED',
  address: '',
  purpose: '',
  ...o,
});

describe('field visits: planning', () => {
  it("an employee plans their own visit; nobody else's", async () => {
    const { svc, visits } = build();
    await expect(
      svc.create(emp, { clientName: 'Acme' }),
    ).resolves.toMatchObject({
      employeeId: 'e1',
      createdById: 'e1',
      scheduledFor: TODAY,
    });
    expect(visits).toHaveLength(1);
    await expect(
      svc.create(emp, { employeeId: 'other', clientName: 'Acme' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('an Admin plans for someone, who is told; a past day, no client, or a non-field employee is refused', async () => {
    const { svc, notes } = build();
    await svc.create(admin, {
      employeeId: 'e1',
      clientName: 'Acme',
      scheduledFor: TODAY,
    });
    expect(notes[0]).toMatchObject({ userId: 'e1', title: 'New field visit' });
    await expect(
      svc.create(admin, {
        employeeId: 'e1',
        clientName: 'Acme',
        scheduledFor: '2020-01-01',
      }),
    ).rejects.toThrow(/past/);
    await expect(
      svc.create(admin, { employeeId: 'e1', clientName: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const off = build({
      person: { id: 'e1', name: 'A', fieldTrackingEnabled: false },
    });
    await expect(
      off.svc.create(admin, { employeeId: 'e1', clientName: 'Acme' }),
    ).rejects.toThrow(/field employees/);
  });
  it('cancel and edit use company-scoped writes and only work on a planned visit', async () => {
    const { svc, visits } = build({ visits: [planned()] });
    await expect(svc.cancel(admin, 'v1', 'Client postponed')).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    await expect(svc.cancel(admin, 'v1', 'Client postponed')).rejects.toThrow(/planned/);
    visits[0].status = 'PLANNED';
    await expect(
      svc.update(admin, 'v1', { clientName: 'Beta Corp' }),
    ).resolves.toMatchObject({ clientName: 'Beta Corp' });
  });
});

describe('field visits: who may change one', () => {
  it('an employee cannot edit or cancel a visit their manager planned, but can their own', async () => {
    const { svc } = build({
      visits: [
        planned({ createdById: 'a1' }),
        planned({ id: 'v2', createdById: 'e1' }),
      ],
    });
    await expect(svc.cancel(emp, 'v1', 'Client postponed')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.update(emp, 'v1', { clientName: 'Hijack' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.cancel(emp, 'v2', 'Client postponed')).resolves.toMatchObject({
      status: 'CANCELLED',
    });
  });
});

describe('field visits: nightly clean-up', () => {
  it('marks old planned visits Missed and closes stale check-ins, and never throws', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const svc = new FieldVisitsService(
      {} as never,
      { fieldVisit: { updateMany } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await svc.closeStale();
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { status: 'PLANNED' },
      data: { status: 'MISSED' },
    });
    expect(updateMany.mock.calls[1][0]).toMatchObject({
      where: { status: 'CHECKED_IN' },
      data: { status: 'COMPLETED', autoClosed: true },
    });
    const broken = new FieldVisitsService(
      {} as never,
      {
        fieldVisit: {
          updateMany: jest.fn().mockRejectedValue(new Error('db')),
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(broken.closeStale()).resolves.toBeUndefined();
  });
});

describe('field visits: check in and out', () => {
  const here = { latitude: 19.0701, longitude: 72.8701, accuracyMeters: 10 };
  it('checks in at the client (in range) and out with a duration', async () => {
    const { svc } = build({ visits: [planned()] });
    const inn = await svc.checkIn(emp, 'v1', here);
    expect(inn).toMatchObject({
      status: 'CHECKED_IN',
      checkInWithinRange: true,
    });
    const out = await svc.checkOut(emp, 'v1', { outcome: ' Order taken ' });
    expect(out).toMatchObject({ status: 'COMPLETED', outcome: 'Order taken' });
    expect(typeof out.durationMinutes).toBe('number');
  });
  it('records far-away check-ins as outside range instead of refusing them', async () => {
    const { svc } = build({ visits: [planned()] });
    const r = await svc.checkIn(emp, 'v1', {
      latitude: 19.1,
      longitude: 72.9,
      accuracyMeters: 10,
    });
    expect(r).toMatchObject({
      status: 'CHECKED_IN',
      checkInWithinRange: false,
    });
    expect(r.checkInDistanceMeters).toBeGreaterThan(1000);
  });
  it("is refused for someone else's visit, another day, without a punch-in, or while still in another visit", async () => {
    await expect(
      build({ visits: [planned({ employeeId: 'x' })] }).svc.checkIn(
        emp,
        'v1',
        here,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      build({ visits: [planned({ scheduledFor: '2099-01-01' })] }).svc.checkIn(
        emp,
        'v1',
        here,
      ),
    ).rejects.toThrow(/later day/);
    await expect(
      build({ visits: [planned()], shift: false }).svc.checkIn(emp, 'v1', here),
    ).rejects.toThrow(/Punch in/);
    await expect(
      build({
        visits: [
          planned(),
          planned({ id: 'v2', status: 'CHECKED_IN', clientName: 'Other Co' }),
        ],
      }).svc.checkIn(emp, 'v1', here),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      build({ visits: [planned()] }).svc.checkIn(emp, 'v1', { latitude: 'x' }),
    ).rejects.toThrow(/location/);
  });
  it('cannot check out of a visit you are not checked in to', async () => {
    await expect(
      build({ visits: [planned()] }).svc.checkOut(emp, 'v1', {}),
    ).rejects.toThrow(/not checked in/);
  });
});
