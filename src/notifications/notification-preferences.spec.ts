import { NotificationCategory as C } from '@prisma/client';
import {
  channelAllowed,
  hiddenInAppCategories,
  mergeChannels,
  readPreferences,
  unknownChannelKeys,
} from './notification-preferences';

describe('notification preferences', () => {
  it('sends everything on every channel to someone who never set anything', () => {
    for (const channel of ['inApp', 'email', 'push'] as const) {
      expect(channelAllowed(undefined, C.LEAVE, channel)).toBe(true);
      expect(channelAllowed({}, C.PAYROLL, channel)).toBe(true);
    }
  });

  it('switches one channel off for one kind without touching the others', () => {
    const prefs = { channels: { PAYROLL: { email: false } } };
    expect(channelAllowed(prefs, C.PAYROLL, 'email')).toBe(false);
    expect(channelAllowed(prefs, C.PAYROLL, 'push')).toBe(true);
    expect(channelAllowed(prefs, C.PAYROLL, 'inApp')).toBe(true);
    expect(channelAllowed(prefs, C.LEAVE, 'email')).toBe(true);
  });

  it('lets the master switches override', () => {
    expect(channelAllowed({ emailEnabled: false }, C.LEAVE, 'email')).toBe(false);
    expect(channelAllowed({ pushEnabled: false }, C.LEAVE, 'push')).toBe(false);
    expect(channelAllowed({ pushEnabled: false }, C.LEAVE, 'inApp')).toBe(true);
  });

  it('keeps the older mute: no inbox, no push, but email still goes', () => {
    const prefs = { mutedCategories: [C.ATTENDANCE] };
    expect(channelAllowed(prefs, C.ATTENDANCE, 'inApp')).toBe(false);
    expect(channelAllowed(prefs, C.ATTENDANCE, 'push')).toBe(false);
    expect(channelAllowed(prefs, C.ATTENDANCE, 'email')).toBe(true);
  });

  it('hides from the inbox both muted kinds and kinds with in-app switched off', () => {
    const hidden = hiddenInAppCategories({ mutedCategories: [C.GENERAL], channels: { LEAVE: { inApp: false }, PAYROLL: { email: false } } });
    expect(hidden.sort()).toEqual([C.GENERAL, C.LEAVE].sort());
  });

  it('merges updates, stores only what differs from the default, and drops what is turned back on', () => {
    const first = mergeChannels({}, { LEAVE: { email: false, push: false } });
    expect(first).toEqual({ LEAVE: { email: false, push: false } });
    const second = mergeChannels(first, { LEAVE: { email: true }, PAYROLL: { inApp: false } });
    expect(second).toEqual({ LEAVE: { push: false }, PAYROLL: { inApp: false } });
  });

  it('ignores junk when reading what is stored', () => {
    expect(readPreferences({ channels: { LEAVE: { email: 'no', push: false }, NOPE: { email: false } } }).channels).toEqual({ LEAVE: { push: false } });
  });

  it('names unknown categories, channels and non-boolean values', () => {
    expect(unknownChannelKeys({ LEAVE: { email: false }, BOGUS: { email: true }, PAYROLL: { sms: true }, GENERAL: { push: 'yes' } })).toEqual(['BOGUS', 'PAYROLL.sms', 'GENERAL.push']);
  });
});
