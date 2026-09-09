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

// Per-account brute-force lockout. @Throttle() on POST /auth/login is
// per-IP, which does nothing against a distributed attack on a single
// account — every IP stays under its own limit while the account itself
// takes unlimited guesses. These cap the account instead.
//
// 10 (not 5) because the per-IP limit already absorbs casual hammering and
// a lower number makes it trivial for anyone to lock a colleague out by
// typing a wrong password at them. Overridable per-environment, same
// pattern as AUTH_THROTTLE_LIMIT — the e2e suite needs a small value so a
// lockout test doesn't take 10 real bcrypt rounds to set up.
export const LOGIN_MAX_FAILED_ATTEMPTS = Number(
  process.env.LOGIN_MAX_FAILED_ATTEMPTS ?? 10,
);
export const LOGIN_LOCKOUT_MINUTES = Number(
  process.env.LOGIN_LOCKOUT_MINUTES ?? 15,
);
