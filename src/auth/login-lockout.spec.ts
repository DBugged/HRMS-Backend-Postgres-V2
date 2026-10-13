import * as bcrypt from 'bcrypt';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

type Row = Record<string, any>;

async function build(opts: { locked: boolean; knownIps: string[] }) {
  const password = await bcrypt.hash('RightPass#1234', 4);
  const user: Row = {
    id: 'u1',
    organizationId: 'org',
    email: 'a@x.com',
    name: 'Asha',
    role: 'EMPLOYEE',
    isActive: true,
    employmentStatus: 'CONFIRMED',
    mustChangePassword: false,
    password,
    lockedUntil: opts.locked ? new Date(Date.now() + 10 * 60_000) : null,
  };
  const cleared: string[] = [];
  const failures: string[] = [];
  const prisma: Row = {
    auditLog: {
      findFirst: async (a: Row) =>
        opts.knownIps.includes(a.where.ipAddress) ? { id: 'l1' } : null,
    },
    refreshToken: { create: async () => ({}) },
  };
  const usersService = {
    findByEmail: async () => user,
    isOrganizationActive: async () => true,
    recordFailedLogin: async () => {
      failures.push('fail');
      return { locked: false };
    },
    clearLoginLock: async () => {
      cleared.push('known-ip');
      return true;
    },
    clearLoginFailuresIfUnlocked: async () => {
      cleared.push('normal');
      return !opts.locked;
    },
    updateLastLogin: async () => undefined,
  };
  const stub = <T>(x: T) => x as never;
  const nothing = stub({});
  const service = new AuthService(
    stub(prisma),
    stub(usersService),
    nothing,
    nothing,
    nothing,
    nothing,
    nothing,
    nothing,
    nothing,
    nothing,
    nothing,
    stub({ log: async () => undefined }),
    nothing,
    nothing,
    stub({ signAsync: async () => 'access-token' }),
  );
  return { service, cleared, failures };
}

process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-12';

describe('login lockout', () => {
  it('a locked account refuses a stranger even with the right password', async () => {
    const { service } = await build({ locked: true, knownIps: [] });
    await expect(
      service.login({ email: 'a@x.com', password: 'RightPass#1234' } as never, {
        ip: '203.0.113.9',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('an address the account signed in from recently can still get in, and lifts the lock', async () => {
    const { service, cleared } = await build({
      locked: true,
      knownIps: ['198.51.100.4'],
    });
    const res = await service.login(
      { email: 'a@x.com', password: 'RightPass#1234' } as never,
      { ip: '198.51.100.4' },
    );
    expect(res.accessToken).toBe('access-token');
    expect(cleared).toEqual(['known-ip']);
  });

  it('a known address with a wrong password is still refused', async () => {
    const { service, failures } = await build({
      locked: true,
      knownIps: ['198.51.100.4'],
    });
    await expect(
      service.login({ email: 'a@x.com', password: 'wrong' } as never, {
        ip: '198.51.100.4',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(failures).toHaveLength(1);
  });
});
