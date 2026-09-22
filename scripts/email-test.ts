// Sends a real test email via the app's EmailService (SMTP or Resend).
// Usage: npm run email:test -- someone@example.com
import 'dotenv/config';
import { EmailService } from '../src/notifications/email.service';

async function main() {
  const to = process.argv[2];
  if (!to || !/^[^@\s]+@[^@\s]+$/.test(to)) {
    console.error('Usage: npm run email:test -- <recipient@example.com>');
    process.exit(1);
  }
  const env = process.env;
  const configured =
    env.EMAIL_DRIVER === 'resend'
      ? !!env.RESEND_API_KEY
      : !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
  if (!configured) {
    console.error(
      env.EMAIL_DRIVER === 'resend'
        ? 'Email is not configured: set RESEND_API_KEY.'
        : 'SMTP is not configured: set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS (and EMAIL_FROM).',
    );
    process.exit(1);
  }
  const { dryRun } = await new EmailService().send({
    to,
    subject: 'HRMS test email',
    html: '<p>This is a test email from the HRMS backend. Delivery is working.</p>',
  });
  // EmailService swallows transport errors and reports dryRun=true.
  if (dryRun) {
    console.error('Send failed (see the error logged above).');
    process.exit(1);
  }
  console.log(`Test email sent to ${to} (host: ${env.SMTP_HOST ?? 'resend'}).`);
  // The SMTP transporter now pools connections (see email.service.ts) — they stay open for reuse,
  // which is exactly what we want in the long-lived server but leaves this short-lived CLI script's
  // event loop non-empty forever. Exit explicitly once the send is done.
  process.exit(0);
}
void main();
