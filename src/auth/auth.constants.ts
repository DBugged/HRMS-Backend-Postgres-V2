// Centralized so the cookie name/path used when *setting* the cookie
// (AuthController) and when *reading* it (nowhere else needs to today, but
// future middleware would) never drift apart.
export const REFRESH_COOKIE_NAME =
  process.env.REFRESH_COOKIE_NAME || 'refresh_token';
export const REFRESH_COOKIE_PATH = process.env.REFRESH_COOKIE_PATH || '/auth';
export const REFRESH_TOKEN_TTL_DAYS = Number(
  process.env.JWT_REFRESH_EXPIRES_IN_DAYS ?? 7,
);
export const ACCESS_TOKEN_TTL_SECONDS = parseAccessTtlToSeconds(
  process.env.JWT_ACCESS_EXPIRES_IN || '15m',
);

function parseAccessTtlToSeconds(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) return 900; // 15m fallback if env var is malformed
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 60;
  return amount * multiplier;
}
