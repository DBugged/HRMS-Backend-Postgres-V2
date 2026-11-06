// Purpose: tells web sign-ins from mobile-app sign-ins, so a person can hold one live session of each kind.
// The apps send X-Client-Type; for an older app build without it, the user agent decides (a browser is "web").
export type ClientType = 'web' | 'mobile';

export const SIGNED_IN_ELSEWHERE_MESSAGE = 'You were signed out because you signed in on another device.';

export function clientTypeOf(headers: Record<string, string | string[] | undefined>): ClientType {
  const declared = String(headers['x-client-type'] ?? '').toLowerCase();
  if (declared === 'web' || declared === 'mobile') return declared;
  const ua = String(headers['user-agent'] ?? '');
  return /okhttp|CFNetwork|Expo|ReactNative|Dart\//i.test(ua) ? 'mobile' : 'web';
}
