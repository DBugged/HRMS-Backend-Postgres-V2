// Purpose: refresh-token reuse. Two tabs refreshing together must both keep their session; a token reused later is still treated as theft.
import { UnauthorizedException } from '@nestjs/common';
import { CcAuthService } from './cc-auth.service';
import { hashToken } from './cc-auth-rules';

const admin = { id: 'a1', role: 'OWNER', status: 'ACTIVE', email: 'a@x.test', name: 'A', mfaEnabled: false, lastLoginAt: null };

function build(session: Record<string, unknown> | null, successor: boolean) {
  const prisma = {
    superAdminSession: {
      findUnique: jest.fn(async () => session),
      findFirst: jest.fn(async () => (successor ? { id: 's2' } : null)),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
    },
  };
  const jwt = { signAsync: jest.fn(async () => 'access') };
  const svc = new CcAuthService(prisma as never, jwt as never, {} as never);
  return { svc, prisma };
}

describe('CcAuthService.refresh reuse', () => {
  beforeAll(() => { process.env.CC_JWT_SECRET = 'x'.repeat(40); });

  it('gives a second tab its own session when the token was swapped moments ago', async () => {
    const { svc, prisma } = build({ id: 's1', superAdminId: 'a1', revokedAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() + 1e6), superAdmin: admin }, true);
    const out = await svc.refresh('old-token', {} as never);
    expect(out.accessToken).toBe('access');
    expect(out.refreshToken).toBeTruthy();
    expect(prisma.superAdminSession.updateMany).not.toHaveBeenCalled(); // nobody is signed out
    expect(prisma.superAdminSession.create).toHaveBeenCalled();
  });

  it('still ends every session when an old token comes back long after the swap', async () => {
    const { svc, prisma } = build({ id: 's1', superAdminId: 'a1', revokedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 1e6), superAdmin: admin }, true);
    await expect(svc.refresh('old-token', {} as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.superAdminSession.updateMany).toHaveBeenCalled();
  });

  it('does not treat a token revoked by sign-out as a rotation', async () => {
    const { svc, prisma } = build({ id: 's1', superAdminId: 'a1', revokedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 1e6), superAdmin: admin }, false);
    await expect(svc.refresh('signed-out-token', {} as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.superAdminSession.create).not.toHaveBeenCalled();
  });

  it('hashes the token it looks up', async () => {
    const { svc, prisma } = build(null, false);
    await expect(svc.refresh('abc', {} as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.superAdminSession.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: hashToken('abc') } }));
  });
});
