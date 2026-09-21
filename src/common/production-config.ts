// Fail-fast startup checks. Everything here is a no-op unless
// NODE_ENV=production so dev/test behave exactly as before.
const isProd = (env: NodeJS.ProcessEnv) => env.NODE_ENV === 'production';

const LOCAL_RE = /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

/** Origins allowed by CORS: CORS_ORIGIN, else FRONTEND_URL (comma-separated). */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CORS_ORIGIN || env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isWeakSecret(v: string | undefined): boolean {
  return (
    !v ||
    v.length < 32 ||
    /^(replace_with|changeme|secret|dev|test)/i.test(v) ||
    /replace_with/i.test(v)
  );
}

/** Returns fatal problems for a production config (empty = OK). */
export function productionConfigProblems(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isProd(env)) return [];
  const p: string[] = [];
  const origins = (env.CORS_ORIGIN || env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0)
    p.push('CORS_ORIGIN or FRONTEND_URL must be set to the frontend origin(s)');
  if (origins.some((o) => o === '*' || LOCAL_RE.test(o)))
    p.push("CORS_ORIGIN/FRONTEND_URL must not be '*' or a localhost origin");
  const fe = env.FRONTEND_URL || origins[0];
  if (!env.FRONTEND_URL)
    p.push('FRONTEND_URL must be set (used in emailed links)');
  else if (LOCAL_RE.test(fe))
    p.push('FRONTEND_URL must not be a localhost URL');
  if (isWeakSecret(env.JWT_ACCESS_SECRET))
    p.push(
      'JWT_ACCESS_SECRET must be set to a strong non-default value (>=32 chars)',
    );
  if (isWeakSecret(env.JWT_REFRESH_SECRET))
    p.push(
      'JWT_REFRESH_SECRET must be set to a strong non-default value (>=32 chars)',
    );
  if (env.JWT_ACCESS_SECRET && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET)
    p.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  return p;
}

/** Non-fatal production config warnings (emails still send, but assets may not render). */
export function productionConfigWarnings(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isProd(env)) return [];
  const w: string[] = [];
  const pub = env.BACKEND_PUBLIC_URL;
  if (!pub || LOCAL_RE.test(pub) || !/^https:\/\//i.test(pub))
    w.push(
      'WARNING: BACKEND_PUBLIC_URL is unset, localhost or not https - the email logo (and other emailed asset URLs) will not load in mail clients.',
    );
  return w;
}

export function assertProductionConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (m: string) => void = (m) => console.warn(m),
): void {
  const problems = productionConfigProblems(env);
  if (problems.length)
    throw new Error(
      `Invalid production configuration:\n - ${problems.join('\n - ')}`,
    );
  productionConfigWarnings(env).forEach((m) => warn(m));
  if (isProd(env) && env.EMAIL_DRIVER !== 'resend' && !env.SMTP_HOST)
    warn(
      'WARNING: SMTP is not configured (SMTP_HOST unset) - emails will not be delivered.',
    );
}

/** Refresh-cookie `secure` flag: on by default in production, env can override. */
export function cookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.COOKIE_SECURE !== undefined && env.COOKIE_SECURE !== '')
    return env.COOKIE_SECURE === 'true';
  return isProd(env);
}

/** Swagger is on outside production; in production only with ENABLE_SWAGGER=true. */
export function swaggerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProd(env) || env.ENABLE_SWAGGER === 'true';
}
