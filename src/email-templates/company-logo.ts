// Purpose: Wires Organization Settings > Branding > Email Logo into outgoing emails — it was captured and
//   validated but nothing actually read it (the upload hint claimed "Used in email templates", which wasn't
//   true until this file existed; the Email Templates screen didn't even offer a {{companyLogo}} placeholder).
import { signFileToken, SESSION_ASSET_TTL_SECONDS } from '../files/file-token';
import { backendPublicUrl } from '../common/backend-url';

// Renders the org's Email Logo as a ready-to-embed <img> tag for the
// {{companyLogo}} merge variable — returns '' when the org hasn't set one,
// so a template using the placeholder just renders nothing extra rather
// than a broken image. The signed URL is absolute (an email client fetches
// images from outside this app entirely, unlike the frontend's own
// resolveFileUrl, which only ever needs an origin-relative path) and uses
// the same 24-hour TTL already accepted for other long-lived branding
// assets (see file-token.ts's SESSION_ASSET_TTL_SECONDS) — an email opened
// well after that window shows a broken image, same trade-off the rest of
// the app already makes for a leaked/stale branding link.
export function companyLogoImgTag(
  organizationId: string,
  emailLogoUrl: string | null | undefined,
): string {
  if (!emailLogoUrl) return '';
  const token = signFileToken(organizationId, emailLogoUrl, SESSION_ASSET_TTL_SECONDS);
  const url = `${backendPublicUrl()}/files/${token}`;
  return `<img src="${url}" alt="" style="max-height:48px;max-width:220px;" />`;
}
