import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrivacyRequestsService } from './privacy-requests.service';

// assertHrMayHandle is private and only reads scopedPrisma; build the service without its other dependencies.
function service(requesterRole: Role) {
  const svc = Object.create(PrivacyRequestsService.prototype) as Record<
    string,
    unknown
  >;
  svc.scopedPrisma = {
    user: { findFirst: async () => ({ role: requesterRole }) },
  };
  return svc as unknown as {
    assertHrMayHandle(
      actor: { id: string; role: Role; organizationId: string },
      requesterId: string,
    ): Promise<void>;
  };
}

const actor = (role: Role, id = 'u1') => ({
  id,
  role,
  organizationId: 'org',
});

describe('who may handle a privacy request', () => {
  it('an Admin may handle their own request', async () => {
    await expect(
      service(Role.ADMIN).assertHrMayHandle(actor(Role.ADMIN), 'u1'),
    ).resolves.toBeUndefined();
  });

  it("HR may not handle their own, nor an HR/Admin colleague's", async () => {
    await expect(
      service(Role.HR).assertHrMayHandle(actor(Role.HR), 'u1'),
    ).rejects.toThrow(/ask an Admin/);
    await expect(
      service(Role.ADMIN).assertHrMayHandle(actor(Role.HR, 'hr9'), 'a1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it("HR may handle an ordinary employee's request", async () => {
    await expect(
      service(Role.EMPLOYEE).assertHrMayHandle(actor(Role.HR, 'hr9'), 'e1'),
    ).resolves.toBeUndefined();
  });
});
