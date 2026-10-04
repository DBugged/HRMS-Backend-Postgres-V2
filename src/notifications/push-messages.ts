// Purpose: Pure helpers for Expo push messages — token validation, what the lock screen is allowed to show, and
//   splitting a send into the chunks Expo accepts.
// Important: a push notification is visible on a locked phone, so payroll-related ones never carry their text
//   (which can include amounts) — they only say there is an update. Everything else is shortened.

export const EXPO_TOKEN_RE = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/;
export const EXPO_CHUNK_SIZE = 100;
export const MAX_DEVICES_PER_USER = 8;
const MAX_BODY = 140;

export function isExpoPushToken(token: unknown): token is string {
  return typeof token === 'string' && EXPO_TOKEN_RE.test(token);
}

export interface PushInput {
  title: string;
  message: string;
  category: string;
  notificationId?: string;
}

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  channelId: 'default';
  priority: 'high';
  data: { category: string; notificationId?: string };
}

export function pushBody(category: string, message: string): string {
  if (category === 'PAYROLL')
    return 'You have a payroll update. Open the app to view it.';
  const clean = message.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_BODY ? `${clean.slice(0, MAX_BODY - 1)}…` : clean;
}

export function buildExpoMessages(
  tokens: string[],
  input: PushInput,
): ExpoMessage[] {
  const body = pushBody(input.category, input.message);
  return tokens.map((to) => ({
    to,
    title: input.title,
    body,
    sound: 'default',
    channelId: 'default',
    priority: 'high',
    data: {
      category: input.category,
      ...(input.notificationId ? { notificationId: input.notificationId } : {}),
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
