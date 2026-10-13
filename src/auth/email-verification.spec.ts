import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';

type Row = Record<string, any>;

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

function build(user: Row | null, emailConfigured = true) {
  const sent: Row[] = [];
  const updates: Row[] = [];
  const prisma: Row = {
    user: {
      findFirst: async (a: Row) =>
        user && a.where.emailVerificationToken === user.emailVerificationToken
          ? { ...user }
          : null,
      updateMany: async (a: Row) => {
        updates.push(a);
        Object.assign(user ?? {}, a.data);
        return { count: 1 };
      },
    },
  };
  const stub = <T>(x: T) => x as never;
  const nothing = stub({});
  const service = new AuthService(
    stub(prisma),
    stub({ findByEmail: async () => user }),
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
    stub({
      send: async (m: Row) => {
        sent.push(m);
        return { dryRun: false };
      },
      isConfigured: () => emailConfigured,
    }),
    nothing,
    nothing,
  );
  return { service, sent, updates };
}

describe('founder email verification', () => {
  const pending = (over: Row = {}) => ({
    id: 'u1',
    organizationId: 'org',
    role: 'ADMIN',
    name: 'Asha',
    email: 'asha@x.com',
    isActive: true,
    emailVerified: false,
    emailVerificationToken: hash('good-token'),
    emailVerificationExpires: new Date(Date.now() + 60_000),
    ...over,
  });

  it('a valid link confirms the address and clears the token', async () => {
    const user = pending();
    const { service } = build(user);
    await service.verifyEmail({ token: 'good-token' });
    expect(user).toMatchObject({
      emailVerified: true,
      emailVerificationToken: null,
      emailVerificationExpires: null,
    });
  });

  it('an unknown or expired link is refused', async () => {
    await expect(
      build(pending()).service.verifyEmail({ token: 'nope' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      build(
        pending({ emailVerificationExpires: new Date(Date.now() - 1000) }),
      ).service.verifyEmail({ token: 'good-token' }),
    ).rejects.toThrow(/invalid or has expired/);
  });

  it('resending mails a fresh link only to an unconfirmed address, with one generic answer', async () => {
    const waiting = build(pending());
    const a = await waiting.service.resendVerification({ email: 'asha@x.com' });
    expect(waiting.sent).toHaveLength(1);
    expect(waiting.sent[0].html).toContain('/verify-email?token=');

    const done = build(pending({ emailVerified: true }));
    const b = await done.service.resendVerification({ email: 'asha@x.com' });
    const none = build(null);
    const c = await none.service.resendVerification({ email: 'x@y.com' });
    expect(done.sent).toHaveLength(0);
    expect(none.sent).toHaveLength(0);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});

describe('registration needs a working mail channel', () => {
  const dto = {
    organizationName: 'Acme',
    name: 'Asha',
    email: 'asha@acme.test',
    password: 'StrongPass#1234',
  } as never;

  it('is refused up front when this server cannot send the confirmation email', async () => {
    const { service } = build(null, false);
    await expect(service.register(dto)).rejects.toThrow(
      /email delivery is not set up/,
    );
  });
});
