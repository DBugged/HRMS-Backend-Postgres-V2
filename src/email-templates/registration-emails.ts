// Purpose: the two emails a self-registered company gets from D'RectHR after a Super Admin reviews its registration.
// Important: pure string builders. Values are escaped here; the caller passes raw text and URLs.
import { button, emailBody, escapeHtml, notice, paragraph } from './email-layout';

export function registrationApprovedHtml(i: { name: string; companyName: string; loginUrl: string }): string {
  return emailBody({
    category: 'Account & Access',
    title: 'Your account is approved',
    blocks: [
      paragraph(`Hi ${escapeHtml(i.name)},`),
      paragraph(`Good news: <strong>${escapeHtml(i.companyName)}</strong> has been approved on D'RectHR. You can now sign in with the email and password you created.`),
      button(escapeHtml(i.loginUrl), 'Sign in to your account'),
      notice("If you didn't register this account, you can safely ignore this email.", 'neutral'),
    ],
  });
}

export function registrationRejectedHtml(i: { name: string; companyName: string; reason?: string | null; registerUrl: string }): string {
  const reason = i.reason?.trim();
  return emailBody({
    category: 'Account & Access',
    title: 'Your registration was not approved',
    blocks: [
      paragraph(`Hi ${escapeHtml(i.name)},`),
      paragraph(`Thank you for your interest in D'RectHR. We could not approve the registration for <strong>${escapeHtml(i.companyName)}</strong> at this time.`),
      reason ? paragraph(`<strong>Reason:</strong> ${escapeHtml(reason)}`) : '',
      paragraph('You are welcome to register again with corrected details, or reply to this email if you have a question.'),
      button(escapeHtml(i.registerUrl), 'Register again'),
    ],
  });
}
