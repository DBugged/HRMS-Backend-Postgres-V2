import { PrivacyRequestsService } from './privacy-requests.service';

// Live-tracking data in a person's own data export, and its removal when personal data is erased.
function build() {
  const calls: { model: string; op: string; args: Record<string, unknown> }[] =
    [];
  const rec =
    (model: string, op: string, result: unknown) =>
    async (args: Record<string, unknown> = {}) => {
      calls.push({ model, op, args });
      return result;
    };
  const user = {
    id: 'u1',
    name: 'Asha',
    email: 'a@x.test',
    personalData: {},
    profileImage: null,
    departmentId: null,
    fieldTrackingEnabled: true,
    fieldTrackingConsentAt: new Date('2026-10-01T00:00:00Z'),
  };
  const ping = {
    recordedAt: new Date('2026-11-01T05:00:00Z'),
    latitude: 19.07,
    longitude: 72.87,
    accuracyMeters: 10,
    kind: 'POINT',
  };
  const visit = {
    clientName: 'Acme',
    scheduledFor: '2026-11-02',
    status: 'COMPLETED',
  };
  const db = {
    user: {
      findFirst: rec('user', 'findFirst', user),
      updateMany: rec('user', 'updateMany', { count: 1 }),
    },
    department: { findFirst: rec('department', 'findFirst', null) },
    organization: {
      findFirst: rec('organization', 'findFirst', {
        fieldTrackingSettings: { retentionDays: 90 },
      }),
    },
    employeeDocument: {
      findMany: rec('employeeDocument', 'findMany', []),
      deleteMany: rec('employeeDocument', 'deleteMany', { count: 0 }),
    },
    documentRequirement: {
      findMany: rec('documentRequirement', 'findMany', []),
    },
    leave: { groupBy: rec('leave', 'groupBy', []) },
    attendance: { groupBy: rec('attendance', 'groupBy', []) },
    payrollRun: { findMany: rec('payrollRun', 'findMany', []) },
    consentRecord: { findMany: rec('consentRecord', 'findMany', []) },
    dataRequest: { findMany: rec('dataRequest', 'findMany', []) },
    locationPing: {
      findMany: rec('locationPing', 'findMany', [ping, ping]),
      deleteMany: rec('locationPing', 'deleteMany', { count: 2 }),
    },
    fieldVisit: {
      findMany: rec('fieldVisit', 'findMany', [visit]),
      updateMany: rec('fieldVisit', 'updateMany', { count: 1 }),
    },
  };
  const svc = new PrivacyRequestsService(
    db as never,
    {} as never,
    { ensureSettings: async () => ({ deletionRules: {} }) } as never,
  );
  return { svc, calls };
}

describe('privacy: location data', () => {
  it('the data export carries the location trail, the agreement and the field visits', async () => {
    const { svc } = build();
    const out = (await svc.buildExport('u1', 'org')) as unknown as {
      liveTracking: {
        switchedOn: boolean;
        agreedAt: Date;
        locationPoints: unknown[];
        note: string;
      };
      fieldVisits: { clientName: string }[];
    };
    expect(out.liveTracking.switchedOn).toBe(true);
    expect(out.liveTracking.agreedAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(out.liveTracking.locationPoints).toHaveLength(2);
    expect(out.liveTracking.note).toMatch(/90 days/);
    expect(out.fieldVisits.map((v) => v.clientName)).toEqual(['Acme']);
  });

  it('erasing personal data deletes the trail, switches tracking off and blanks visit coordinates', async () => {
    const { svc, calls } = build();
    const outcome = await (
      svc as unknown as {
        anonymize: (
          u: string,
          o: string,
        ) => Promise<{ locationPointsRemoved: number }>;
      }
    ).anonymize('u1', 'org');
    expect(outcome.locationPointsRemoved).toBe(2);
    const del = calls.find(
      (c) => c.model === 'locationPing' && c.op === 'deleteMany',
    );
    expect(del?.args).toEqual({
      where: { organizationId: 'org', employeeId: 'u1' },
    });
    const off = calls.find(
      (c) =>
        c.model === 'user' &&
        c.op === 'updateMany' &&
        'fieldTrackingEnabled' in
          ((c.args as { data: Record<string, unknown> }).data ?? {}),
    );
    expect((off?.args as { data: unknown }).data).toEqual({
      fieldTrackingEnabled: false,
      fieldTrackingConsentAt: null,
    });
    const blank = calls.find(
      (c) => c.model === 'fieldVisit' && c.op === 'updateMany',
    );
    expect(
      (blank?.args as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      checkInLatitude: null,
      checkInLongitude: null,
      checkOutLatitude: null,
    });
  });
});
