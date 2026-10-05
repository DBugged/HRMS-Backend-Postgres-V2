import {
  buildExpoMessages,
  chunk,
  deadTokens,
  isExpoPushToken,
  pushBody,
  pushTitle,
  ticketErrors,
} from './push-messages';
import { PushService } from './push.service';

describe('push-messages', () => {
  it('accepts only Expo push tokens', () => {
    expect(isExpoPushToken('ExponentPushToken[abc_DEF-123]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[abc]')).toBe(true);
    expect(isExpoPushToken('fcm:APA91b...')).toBe(false);
    expect(isExpoPushToken('ExponentPushToken[]')).toBe(false);
    expect(isExpoPushToken(undefined)).toBe(false);
  });

  it('never puts payroll text on the lock screen', () => {
    expect(
      pushBody('PAYROLL', 'Your salary of ₹1,20,000 is credited'),
    ).not.toMatch(/1,20,000|salary/i);
    expect(pushBody('LEAVE', 'Your leave was approved')).toBe(
      'Your leave was approved',
    );
  });

  it('shortens long bodies and collapses whitespace', () => {
    const b = pushBody('GENERAL', `hello\n\n   ${'x'.repeat(300)}`);
    expect(b.length).toBeLessThanOrEqual(140);
    expect(b.startsWith('hello x')).toBe(true);
    expect(b.endsWith('…')).toBe(true);
  });

  it('builds one message per token with the routing data', () => {
    const m = buildExpoMessages(['ExpoPushToken[a]', 'ExpoPushToken[b]'], {
      title: 'Leave approved',
      message: 'ok',
      category: 'LEAVE',
      notificationId: 'n1',
    });
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({
      to: 'ExpoPushToken[a]',
      channelId: 'default',
      data: { category: 'LEAVE', notificationId: 'n1' },
    });
  });

  it('carries the approval kind so the phone opens its approvals list', () => {
    const [m] = buildExpoMessages(['ExpoPushToken[a]'], {
      title: 'Overtime Requested',
      message: 'pending',
      category: 'ATTENDANCE',
      pushKind: 'APPROVAL',
    });
    expect(m.data).toMatchObject({ category: 'ATTENDANCE', kind: 'APPROVAL' });
    const [plain] = buildExpoMessages(['ExpoPushToken[a]'], {
      title: 'x',
      message: 'y',
      category: 'LEAVE',
    });
    expect(plain.data).not.toHaveProperty('kind');
  });

  it('caps a long title and sets the iOS badge only when given one', () => {
    expect(pushTitle(`  ${'t'.repeat(200)} `).length).toBeLessThanOrEqual(65);
    expect(pushTitle('Holiday  on\nFriday')).toBe('Holiday on Friday');
    const [withBadge] = buildExpoMessages(
      ['ExpoPushToken[a]'],
      { title: 'x', message: 'y', category: 'GENERAL' },
      3,
    );
    expect(withBadge.badge).toBe(3);
    const [noBadge] = buildExpoMessages(['ExpoPushToken[a]'], {
      title: 'x',
      message: 'y',
      category: 'GENERAL',
    });
    expect(noBadge).not.toHaveProperty('badge');
  });

  it('reports rejected pushes other than dead tokens', () => {
    const msgs = [{ to: 'A' }, { to: 'B' }, { to: 'C' }];
    expect(
      ticketErrors(msgs, [
        { status: 'ok' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        {
          status: 'error',
          message: 'Unable to retrieve the FCM server key',
          details: { error: 'InvalidCredentials' },
        },
      ]),
    ).toEqual([
      {
        to: 'C',
        error: 'InvalidCredentials',
        message: 'Unable to retrieve the FCM server key',
      },
    ]);
  });

  it('chunks into groups of 100', () => {
    expect(
      chunk(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length),
    ).toEqual([100, 100, 50]);
  });

  it('finds tokens Expo says are dead', () => {
    const msgs = [{ to: 'A' }, { to: 'B' }, { to: 'C' }];
    expect(
      deadTokens(msgs, [
        { status: 'ok' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', details: { error: 'MessageRateExceeded' } },
      ]),
    ).toEqual(['B']);
  });
});

describe('PushService.notify', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
  });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function make(opts: {
    devices: { userId: string; token: string }[];
    users: { id: string; notificationPreferences: unknown }[];
    unread?: { userId: string; _count: { _all: number } }[];
  }) {
    const deleted: string[][] = [];
    const scoped = {
      pushDevice: {
        findMany: jest.fn().mockResolvedValue(opts.devices),
        deleteMany: jest
          .fn()
          .mockImplementation(
            ({ where }: { where: { token?: { in: string[] } } }) => {
              if (where.token?.in) deleted.push(where.token.in);
              return Promise.resolve({ count: 1 });
            },
          ),
      },
      user: { findMany: jest.fn().mockResolvedValue(opts.users) },
      notification: {
        groupBy: jest
          .fn()
          .mockResolvedValue(
            opts.unread ?? [{ userId: 'u1', _count: { _all: 2 } }],
          ),
      },
    };
    const svc = new PushService(scoped as never, {} as never);
    return { svc, scoped, deleted };
  }

  const flush = () => new Promise((r) => setTimeout(r, 20));
  const target = (userId: string, category = 'LEAVE') => ({
    organizationId: 'o1',
    userId,
    title: 'T',
    message: 'M',
    category,
  });

  it('sends to a user with a device and drops tokens Expo reports dead', async () => {
    const { svc, deleted } = make({
      devices: [
        { userId: 'u1', token: 'ExpoPushToken[a]' },
        { userId: 'u1', token: 'ExpoPushToken[b]' },
      ],
      users: [{ id: 'u1', notificationPreferences: null }],
    });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { status: 'ok' },
            { status: 'error', details: { error: 'DeviceNotRegistered' } },
          ],
        }),
    } as Response);
    svc.notify([target('u1')]);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { to: string; badge?: number }[];
    expect(sent.map((m) => m.to)).toEqual([
      'ExpoPushToken[a]',
      'ExpoPushToken[b]',
    ]);
    // The recipient's unread count rides along as the app-icon badge.
    expect(sent.every((m) => m.badge === 2)).toBe(true);
    expect(deleted).toEqual([['ExpoPushToken[b]']]);
  });

  it('respects push off and muted categories', async () => {
    const { svc } = make({
      devices: [
        { userId: 'u1', token: 'ExpoPushToken[a]' },
        { userId: 'u2', token: 'ExpoPushToken[b]' },
      ],
      users: [
        { id: 'u1', notificationPreferences: { pushEnabled: false } },
        { id: 'u2', notificationPreferences: { mutedCategories: ['LEAVE'] } },
      ],
    });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    } as Response);
    svc.notify([target('u1'), target('u2')]);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the push service is down', async () => {
    const { svc } = make({
      devices: [{ userId: 'u1', token: 'ExpoPushToken[a]' }],
      users: [{ id: 'u1', notificationPreferences: null }],
    });
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    expect(() => svc.notify([target('u1')])).not.toThrow();
    await flush();
  });

  it('counts only broadcast recipients a push would actually reach', async () => {
    const { svc } = make({
      devices: [
        { userId: 'u1', token: 'ExpoPushToken[a]' },
        { userId: 'u2', token: 'ExpoPushToken[b]' },
        { userId: 'u3', token: 'ExpoPushToken[c]' },
      ],
      users: [
        { id: 'u1', notificationPreferences: null },
        { id: 'u2', notificationPreferences: { pushEnabled: false } },
        { id: 'u3', notificationPreferences: { mutedCategories: ['GENERAL'] } },
        { id: 'u4', notificationPreferences: null }, // no phone registered
      ],
    });
    expect(await svc.countReachable('o1', ['u1', 'u2', 'u3', 'u4'])).toBe(1);
    expect(await svc.countReachable('o1', [])).toBe(0);
  });

  it('does nothing in the test environment', async () => {
    process.env.NODE_ENV = 'test';
    const { svc, scoped } = make({ devices: [], users: [] });
    svc.notify([target('u1')]);
    await flush();
    expect(scoped.pushDevice.findMany).not.toHaveBeenCalled();
  });
});
