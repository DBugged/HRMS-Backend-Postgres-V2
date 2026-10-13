import { forgetOrganizationStatus } from '../common/org-status';
import { PlatformInternalService } from './platform-internal.service';

type Row = Record<string, any>;

function build(
  org: Row | null = { id: 'o1', isActive: true, platformStatus: 'ACTIVE' },
) {
  const updates: Row[] = [];
  const audits: Row[] = [];
  const prisma = {
    organization: {
      findUnique: async () => (org ? { ...org } : null),
      update: async (a: Row) => {
        updates.push(a);
        return {};
      },
    },
    user: { findFirst: async () => ({ id: 'founder' }) },
    auditLog: {
      create: async (a: Row) => {
        audits.push(a.data);
        return {};
      },
    },
  };
  return {
    service: new PlatformInternalService(prisma as never),
    updates,
    audits,
  };
}

beforeEach(() => forgetOrganizationStatus());

describe('platform status changes', () => {
  it.each([
    ['SUSPENDED', false],
    ['ARCHIVED', false],
    ['ACTIVE', true],
    ['PENDING', true],
  ])(
    '%s sets isActive to %s and keeps the platform status',
    async (status, active) => {
      const { service, updates } = build();
      await service.setOrgStatus('o1', status, 'because');
      expect(updates[0].data).toEqual({
        isActive: active,
        platformStatus: status,
      });
    },
  );

  it("is recorded in the organisation's audit log as a platform action", async () => {
    const { service, audits } = build();
    await service.setOrgStatus('o1', 'SUSPENDED', 'non-payment');
    expect(audits[0]).toMatchObject({
      organizationId: 'o1',
      actorRole: 'PLATFORM',
      action: 'PLATFORM_ORG_STATUS_CHANGED',
      details: { from: 'ACTIVE', to: 'SUSPENDED', reason: 'non-payment' },
    });
  });

  it('reports the platform status, not just on/off', async () => {
    const { service } = build({
      id: 'o1',
      name: 'Acme',
      isActive: false,
      platformStatus: 'ARCHIVED',
      _count: { users: 3 },
    });
    expect((await service.getOrg('o1')).status).toBe('ARCHIVED');
  });
});
