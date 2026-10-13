// Purpose: who may create a new organisation through the public registration endpoint.
// Responsibilities: reads REGISTRATION_ENABLED / REGISTRATION_INVITE_CODES and decides, in constant time, whether a
//   registration request is allowed.
// Important: registration is open by default (existing behaviour). Setting REGISTRATION_ENABLED=false makes it
//   invitation-only: a request must carry one of the comma-separated REGISTRATION_INVITE_CODES. This replaces the
//   idea of trusting an unverified email address: the platform operator decides who can create tenants.
import { createHash, timingSafeEqual } from 'crypto';

export function registrationOpen(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.REGISTRATION_ENABLED !== 'false';
}

const digest = (v: string) => createHash('sha256').update(v).digest();

export function inviteCodeValid(
  provided: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const code = (provided ?? '').trim();
  if (!code) return false;
  const p = digest(code);
  let ok = false;
  for (const c of (env.REGISTRATION_INVITE_CODES ?? '').split(',')) {
    const candidate = c.trim();
    // Every code is compared (no early exit) so timing does not reveal which one matched.
    if (candidate && timingSafeEqual(p, digest(candidate))) ok = true;
  }
  return ok;
}

export function registrationAllowed(
  inviteCode: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return registrationOpen(env) || inviteCodeValid(inviteCode, env);
}
