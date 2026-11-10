// Purpose: whether an organisation may be used at all - the platform's suspend/archive switch.
// Responsibilities: one cached lookup shared by sign-in, token refresh and the per-request session check, and a way
//   for the platform service to drop an entry the moment it changes the status.
// Important: the cache is per process and short (15s), so a suspension takes effect everywhere within that time even
//   behind several instances; it exists so the check does not add a query to every request.
export const ORG_SUSPENDED_MESSAGE =
  "This organization's account is suspended. Please contact your administrator or support.";

// A self-registered company is PENDING until a Super Admin approves it in the Control Center. Until then nobody in it can sign in
// (isActive is false), but resetting a password still works.
export const ORG_PENDING_MESSAGE =
  'Your account is awaiting approval. We will email you as soon as it is approved, and you can sign in after that.';

/** Which message to show when an inactive organisation is refused: awaiting approval, or suspended/archived. */
export function organizationBlockedMessage(platformStatus: string | null | undefined): string {
  return platformStatus === 'PENDING' ? ORG_PENDING_MESSAGE : ORG_SUSPENDED_MESSAGE;
}

const TTL_MS = 15_000;
const cache = new Map<string, { active: boolean; expires: number }>();

interface OrgReader {
  organization: {
    findFirst(args: {
      where: { id: string };
      select: { isActive: true };
    }): Promise<{ isActive: boolean } | null>;
  };
}

export async function isOrganizationActive(
  prisma: OrgReader,
  organizationId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const hit = cache.get(organizationId);
  if (hit && hit.expires > now) return hit.active;
  const org = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { isActive: true },
  });
  // An organisation that cannot be found is not usable either.
  const active = org?.isActive === true;
  cache.set(organizationId, { active, expires: now + TTL_MS });
  return active;
}

export function forgetOrganizationStatus(organizationId?: string): void {
  if (organizationId) cache.delete(organizationId);
  else cache.clear();
}
