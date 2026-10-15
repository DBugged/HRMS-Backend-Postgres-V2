// Purpose: The two emails a brand-new organization's founder gets from D'CoreHR itself - the welcome right after
//   registration and a re-sent confirmation link. Built from the shared email components so they look like every
//   other designed email (heading, steps, a real button) instead of plain paragraphs.
// Important: pure string builders. Values are escaped here; the caller passes raw text and URLs.
import {
  button,
  emailBody,
  escapeHtml,
  mutedText,
  notice,
  orderedSteps,
  paragraph,
} from './email-layout';

export interface FounderWelcomeInput {
  name: string;
  companyName: string;
  loginUrl: string;
  /** The confirmation link; null when email confirmation is not required (then the email goes straight to login). */
  verifyUrl: string | null;
}

export function founderWelcomeHtml(i: FounderWelcomeInput): string {
  const name = escapeHtml(i.name);
  const company = escapeHtml(i.companyName);
  const verify = i.verifyUrl !== null;
  return emailBody({
    category: 'Account & Access',
    title: verify ? 'Confirm your email to get started' : 'Your account is ready',
    blocks: [
      paragraph(`Hi ${name},`),
      paragraph(
        verify
          ? `Thank you for creating <strong>${company}</strong> on D'CoreHR. One quick step: confirm your email address to activate your account.`
          : `Thank you for creating <strong>${company}</strong> on D'CoreHR. Your account is ready to use.`,
      ),
      verify
        ? button(escapeHtml(i.verifyUrl as string), 'Confirm my email address')
        : button(escapeHtml(i.loginUrl), 'Log in to your account'),
      verify ? mutedText('This link is valid for 48 hours.') : '',
      paragraph('<strong>What happens next</strong>'),
      orderedSteps([
        verify
          ? '<strong>Confirm your email</strong> using the button above.'
          : '<strong>Log in</strong> with the email and password you created.',
        '<strong>Complete your Organization Setup</strong> - company profile, registration details, contact information and branding.',
        '<strong>Add your people</strong> - then manage attendance, leave and payroll from one place.',
      ]),
      verify
        ? mutedText(
            `Already confirmed? <a href="${escapeHtml(i.loginUrl)}" style="color:#5546e0;text-decoration:underline;">Log in</a>.`,
          )
        : '',
      notice(
        "If you didn't create this account, you can safely ignore this email.",
        'neutral',
      ),
    ],
  });
}

export function confirmEmailHtml(i: {
  name: string;
  verifyUrl: string;
}): string {
  return emailBody({
    category: 'Account & Access',
    title: 'Confirm your email address',
    blocks: [
      paragraph(`Hi ${escapeHtml(i.name)},`),
      paragraph(
        'Please confirm your email address to activate your D\'CoreHR account.',
      ),
      button(escapeHtml(i.verifyUrl), 'Confirm my email address'),
      mutedText('This link is valid for 48 hours.'),
      notice(
        "If you didn't ask for this, you can safely ignore this email.",
        'neutral',
      ),
    ],
  });
}
