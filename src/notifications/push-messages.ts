// Purpose: Pure helpers for Expo push messages — token validation, what the lock screen is allowed to show, and
//   splitting a send into the chunks Expo accepts.
// Important: a push notification is visible on a locked phone, so payroll-related ones never carry their text
//   (which can include amounts) — they only say there is an update. Everything else is shortened.

export const EXPO_TOKEN_RE = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/;
export const EXPO_CHUNK_SIZE = 100;
export const MAX_DEVICES_PER_USER = 8;
const MAX_BODY = 140;
// Expo rejects a message over ~4KB; a broadcast title has no length limit of its own, so it is capped here.
const MAX_TITLE = 65;

export function isExpoPushToken(token: unknown): token is string {
  return typeof token === 'string' && EXPO_TOKEN_RE.test(token);
}

export interface PushInput {
  title: string;
  message: string;
  category: string;
  notificationId?: string;
  // 'APPROVAL' = a request waiting for the recipient's decision; the phone opens its approvals list on tap.
  pushKind?: 'APPROVAL';
}

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  channelId: 'default';
  priority: 'high';
  // iOS app-icon badge: the recipient's unread count. Android ignores it.
  badge?: number;
  data: { category: string; notificationId?: string; kind?: 'APPROVAL' };
}

export function pushBody(category: string, message: string): string {
  if (category === 'PAYROLL')
    return 'You have a payroll update. Open the app to view it.';
  const clean = message.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_BODY ? `${clean.slice(0, MAX_BODY - 1)}…` : clean;
}

export function pushTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1)}…` : clean;
}

export function buildExpoMessages(
  tokens: string[],
  input: PushInput,
  badge?: number,
): ExpoMessage[] {
  const body = pushBody(input.category, input.message);
  return tokens.map((to) => ({
    to,
    title: pushTitle(input.title),
    body,
    sound: 'default',
    channelId: 'default',
    priority: 'high',
    ...(badge !== undefined ? { badge } : {}),
    data: {
      category: input.category,
      ...(input.notificationId ? { notificationId: input.notificationId } : {}),
      ...(input.pushKind ? { kind: input.pushKind } : {}),
    },
  }));
}

export function chunk<T>(items: T[], size = EXPO_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

// Expo answers each message with a ticket; "DeviceNotRegistered" means the app was uninstalled or the token
// expired — that token must be dropped so we stop sending to it.
export function deadTokens(
  messages: { to: string }[],
  tickets: { status?: string; details?: { error?: string } }[],
): string[] {
  const dead: string[] = [];
  tickets.forEach((t, i) => {
    if (
      t?.status === 'error' &&
      t.details?.error === 'DeviceNotRegistered' &&
      messages[i]
    ) {
      dead.push(messages[i].to);
    }
  });
  return dead;
}

// Every ticket Expo rejected for a reason other than a dead token (bad FCM/APNs credentials, an oversized payload,
// a malformed message...). These were previously dropped silently, so a phone that never received anything left no
// trace on the server. DeviceNotRegistered is excluded: deadTokens() handles it by removing the token.
export function ticketErrors(
  messages: { to: string }[],
  tickets: {
    status?: string;
    message?: string;
    details?: { error?: string };
  }[],
): { to: string; error: string; message: string }[] {
  const out: { to: string; error: string; message: string }[] = [];
  tickets.forEach((t, i) => {
    if (t?.status !== 'error' || t.details?.error === 'DeviceNotRegistered')
      return;
    out.push({
      to: messages[i]?.to ?? 'unknown',
      error: t.details?.error ?? 'unknown',
      message: t.message ?? '',
    });
  });
  return out;
}
