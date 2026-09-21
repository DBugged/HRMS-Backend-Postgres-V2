// Purpose: Wires Organization Settings > Branding > Email Logo into outgoing emails ({{companyLogo}} and the
//   shell header logo).
// Important: the URL is DURABLE — GET /public/branding/:organizationId/email-logo (see
//   files/public-branding.controller.ts) never expires. It used to be a 24h signed /files/<token> URL, which
//   showed a broken image for any email opened after a day. Emails also need an absolute, publicly reachable
//   https origin, so BACKEND_PUBLIC_URL must be set in production (validated in common/production-config.ts).
import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { backendPublicUrl } from '../common/backend-url';

const logger = new Logger('EmailLogo');
let warnedUnreachable = false;

const LOCAL_RE = /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Cache-buster: changes whenever the stored logo key changes (each upload gets a new generated key).
export function logoVersion(storedKey: string): string {
  return createHash('sha256').update(storedKey).digest('hex').slice(0, 8);
}

export function emailLogoUrl(
  organizationId: string,
  storedKey: string,
): string {
  const base = backendPublicUrl().replace(/\/+$/, '');
  if (
    !warnedUnreachable &&
    process.env.NODE_ENV === 'production' &&
    (!process.env.BACKEND_PUBLIC_URL ||
      LOCAL_RE.test(base) ||
      !/^https:\/\//i.test(base))
  ) {
    warnedUnreachable = true;
    logger.warn(
      `WARNING: BACKEND_PUBLIC_URL ("${base}") is not a public https URL - the email logo will not load in mail clients.`,
    );
  }
  return `${base}/public/branding/${organizationId}/email-logo?v=${logoVersion(storedKey)}`;
}

// Returns '' when the org hasn't set a logo so a template using the placeholder renders nothing extra.
// alt defaults to "" (the email shell fills in the company name); pass companyName to set it directly.
export function companyLogoImgTag(
  organizationId: string,
  storedEmailLogoKey: string | null | undefined,
  companyName?: string | null,
): string {
  if (!storedEmailLogoKey) return '';
  const url = emailLogoUrl(organizationId, storedEmailLogoKey);
  const alt = escAttr((companyName ?? '').trim());
  return `<img src="${escAttr(url)}" alt="${alt}" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-height:48px;max-width:220px;" />`;
}
