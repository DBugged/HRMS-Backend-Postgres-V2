// Purpose: when a person's access ends because their last working day has passed.
// Responsibilities: the rule (access ends once the date is after the last working day, in the organisation's own time zone), the
//   message shown, and a short-lived lookup of "today" for an organisation so the per-request session check costs no extra query.
// Important: this only blocks signing in and using a session. The account itself stays active until HR completes the exit (the
//   final settlement still has to be processed), and the person's final documents are emailed to their personal address.
import { todayInOrgTz } from './org-date';

export const EXIT_ACCESS_ENDED_MESSAGE =
  'Your last working day has passed, so access to this account has ended. Your final documents are emailed to your personal email address - contact HR if anything is missing.';

/** True once `today` is after the last working day (the last working day itself is still a working day). */
export function exitAccessEnded(exitDate: string | null | undefined, today: string): boolean {
  return !!exitDate && exitDate < today;
}

const TTL_MS = 60_000;
const cache = new Map<string, { today: string; expires: number }>();

interface TimezoneReader {
  organization: {
    findFirst(args: { where: { id: string }; select: { timezone: true } }): Promise<{ timezone: string | null } | null>;
  };
}

/** Today's date (YYYY-MM-DD) in the organisation's time zone, cached for a minute. */
export async function organizationToday(prisma: TimezoneReader, organizationId: string, now: number = Date.now()): Promise<string> {
  const hit = cache.get(organizationId);
  if (hit && hit.expires > now) return hit.today;
  const org = await prisma.organization.findFirst({ where: { id: organizationId }, select: { timezone: true } });
  const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata', new Date(now));
  cache.set(organizationId, { today, expires: now + TTL_MS });
  return today;
}
