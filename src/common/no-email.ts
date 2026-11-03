// Purpose: how a person with no email address is represented, and how a company chooses how its people sign in.
// Responsibilities: a placeholder login address (never deliverable), the check for it, and the two company choices
//   (Organization Settings > Policies > Sign-in): the sign-in method and whether people may have no email.
// Important: the placeholder uses the reserved ".invalid" top-level domain, which can never receive mail, so nothing is ever sent
//   there by mistake; EmailService also refuses to send to it. The unique, required users.email column is left as it is.
export const NO_EMAIL_DOMAIN = 'noemail.invalid';

export const placeholderEmailFor = (employeeId: string): string =>
  `${employeeId.toLowerCase().replace(/[^a-z0-9-]/g, '')}@${NO_EMAIL_DOMAIN}`;

/** True for the placeholder, or any address that can never receive mail. */
export const isPlaceholderEmail = (email: string | null | undefined): boolean =>
  typeof email === 'string' && email.trim().toLowerCase().endsWith('.invalid');

export type LoginMethod = 'EMAIL' | 'EMAIL_OR_ID' | 'ID_ONLY';
export const LOGIN_METHODS: readonly LoginMethod[] = ['EMAIL', 'EMAIL_OR_ID', 'ID_ONLY'];

export interface LoginPolicy {
  method: LoginMethod;
  allowNoEmail: boolean;
}

export function readLoginPolicy(policies: unknown): LoginPolicy {
  const p = (policies ?? {}) as { loginMethod?: unknown; allowNoEmail?: unknown };
  return {
    method: (LOGIN_METHODS as readonly unknown[]).includes(p.loginMethod) ? (p.loginMethod as LoginMethod) : 'EMAIL_OR_ID',
    allowNoEmail: p.allowNoEmail === true,
  };
}

/** Why this way of signing in is not allowed for a company, or null when it is. `usedEmail` = the person typed an email address. */
export function loginRefusal(policy: LoginPolicy, usedEmail: boolean, accountHasEmail: boolean): string | null {
  if (!usedEmail && policy.method === 'EMAIL') return 'Your company signs in with an email address. Please enter your email.';
  if (usedEmail && policy.method === 'ID_ONLY' && accountHasEmail) return 'Your company signs in with the employee ID. Please enter your employee ID.';
  return null;
}
