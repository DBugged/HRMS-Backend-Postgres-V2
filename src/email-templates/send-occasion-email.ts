// Purpose: One call to send an occasion email (rendered from the organization's template, or the built-in default) to a person.
// Responsibilities: honours the recipient's email preference for the General category, renders through renderOccasion with the
//   default as fallback, and sends; never throws - an email problem must not fail the action that triggered it.
import { NotificationCategory } from '@prisma/client';
import { channelAllowed } from '../notifications/notification-preferences';
import type { EmailService } from '../notifications/email.service';
import type { EmailTemplatesService } from './email-templates.service';

export async function sendOccasionEmail(
  emailService: EmailService,
  templates: EmailTemplatesService,
  p: {
    organizationId: string;
    to: string | null | undefined;
    occasionKey: string;
    variables: Record<string, string>;
    notificationPreferences?: unknown;
    brandId?: string | null;
  },
): Promise<boolean> {
  if (!p.to) return false;
  try {
    if (p.notificationPreferences !== undefined && !channelAllowed(p.notificationPreferences as never, NotificationCategory.GENERAL, 'email')) return false;
    const rendered = await templates.renderOccasion(p.organizationId, p.occasionKey, p.variables, templates.defaultFor(p.occasionKey, p.variables), { brandId: p.brandId });
    await emailService.send({ organizationId: p.organizationId, to: p.to, subject: rendered.subject, html: rendered.html });
    return true;
  } catch {
    return false;
  }
}
