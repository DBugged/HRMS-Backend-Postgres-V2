// Purpose: What a person has chosen to receive, per kind of notification and per channel (in-app, email, push).
// Important: pure. Stored on User.notificationPreferences. Everything is on unless switched off, so people (and old
//   records) who never set anything keep getting everything. Three layers, all of which must allow it:
//   - the master switches: emailEnabled and pushEnabled (an in-app inbox has no master switch);
//   - mutedCategories (the older "mute this kind" choice): hides it from the inbox and stops the push, as before;
//   - channels[category][channel] = false: switches one channel off for one kind of notification.
//   Email has never been affected by mutedCategories, and that stays the same.
import { NotificationCategory } from '@prisma/client';

export type NotificationChannel = 'inApp' | 'email' | 'push';
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['inApp', 'email', 'push'];

/** The kinds a person can control. ONBOARDING exists in the schema but nothing sends it. */
export const CONTROLLABLE_CATEGORIES: readonly NotificationCategory[] = [
  NotificationCategory.LEAVE,
  NotificationCategory.REGULARIZATION,
  NotificationCategory.PAYROLL,
  NotificationCategory.ATTENDANCE,
  NotificationCategory.GENERAL,
];

export type ChannelChoices = Partial<Record<NotificationChannel, boolean>>;

export interface NotificationPreferences {
  mutedCategories: NotificationCategory[];
  emailEnabled: boolean;
  pushEnabled: boolean;
  channels: Partial<Record<NotificationCategory, ChannelChoices>>;
}

export function readPreferences(raw: unknown): NotificationPreferences {
  const p = (raw ?? {}) as Partial<NotificationPreferences>;
  const channels: NotificationPreferences['channels'] = {};
  for (const category of CONTROLLABLE_CATEGORIES) {
    const entry = (p.channels ?? {})[category];
    if (!entry || typeof entry !== 'object') continue;
    const clean: ChannelChoices = {};
    for (const channel of NOTIFICATION_CHANNELS) {
      if (typeof entry[channel] === 'boolean') clean[channel] = entry[channel];
    }
    if (Object.keys(clean).length > 0) channels[category] = clean;
  }
  return {
    mutedCategories: Array.isArray(p.mutedCategories) ? p.mutedCategories : [],
    emailEnabled: p.emailEnabled ?? true,
    pushEnabled: p.pushEnabled ?? true,
    channels,
  };
}

/** Whether this person wants a notification of this kind on this channel. */
export function channelAllowed(
  raw: unknown,
  category: NotificationCategory,
  channel: NotificationChannel,
): boolean {
  const prefs = readPreferences(raw);
  if (prefs.channels[category]?.[channel] === false) return false;
  if (channel === 'email') return prefs.emailEnabled;
  if (prefs.mutedCategories.includes(category)) return false;
  if (channel === 'push') return prefs.pushEnabled;
  return true;
}

/** The kinds kept out of the person's inbox: muted ones, and ones with the in-app channel switched off. */
export function hiddenInAppCategories(raw: unknown): NotificationCategory[] {
  const prefs = readPreferences(raw);
  const hidden = new Set<NotificationCategory>(prefs.mutedCategories);
  for (const category of CONTROLLABLE_CATEGORIES) {
    if (prefs.channels[category]?.inApp === false) hidden.add(category);
  }
  return [...hidden];
}

/** Changes to the channel choices, merged into what is stored (a category/channel not mentioned keeps its value). */
export function mergeChannels(
  current: NotificationPreferences['channels'],
  update: Partial<Record<string, Partial<Record<string, unknown>>>>,
): NotificationPreferences['channels'] {
  const next: NotificationPreferences['channels'] = {};
  for (const category of CONTROLLABLE_CATEGORIES) {
    const merged: ChannelChoices = { ...(current[category] ?? {}) };
    const incoming = update[category];
    if (incoming) {
      for (const channel of NOTIFICATION_CHANNELS) {
        if (typeof incoming[channel] === 'boolean') merged[channel] = incoming[channel] as boolean;
      }
    }
    // Only what differs from the default (on) is stored.
    for (const channel of NOTIFICATION_CHANNELS) if (merged[channel] === true) delete merged[channel];
    if (Object.keys(merged).length > 0) next[category] = merged;
  }
  return next;
}

/** Names that are not a controllable category or channel (so the request can be refused instead of ignored). */
export function unknownChannelKeys(update: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const [category, value] of Object.entries(update)) {
    if (!(CONTROLLABLE_CATEGORIES as readonly string[]).includes(category)) {
      bad.push(category);
      continue;
    }
    if (!value || typeof value !== 'object') {
      bad.push(category);
      continue;
    }
    for (const [channel, v] of Object.entries(value as Record<string, unknown>)) {
      if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel) || typeof v !== 'boolean') {
        bad.push(`${category}.${channel}`);
      }
    }
  }
  return bad;
}
