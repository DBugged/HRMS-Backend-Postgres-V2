// Purpose: Single outbound-email gateway for the whole app, switchable between Resend and SMTP.
// Responsibilities: Owns provider selection (EMAIL_DRIVER env var), lazy transporter/client construction,
// and the dry-run/console fallback (recipient + subject only — the body can carry credentials and is never logged).
// Important: send() never throws — any provider failure (or missing credentials) degrades to a console
// dry-run log rather than propagating, so a bad SMTP/Resend config can never fail the caller's business
// action. Only an explicit EMAIL_DRIVER=resend switches off the default SMTP path.
import { Inject, Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  cc?: string[];
  attachments?: EmailAttachment[];
  // Optional — when the caller has one in scope, pass it so a verified
  // custom sending domain (Organization Settings > Email Sending) is used
  // instead of the shared platform address. Omitted callers (or an org
  // that never verified a domain) keep today's behavior unchanged.
  organizationId?: string;
}

// Addresses under the reserved test domains (RFC 2606: .test, .example, .invalid, .localhost, and example.com / .net /
// .org) can never be delivered. Seeded and load-test accounts use them, and trying anyway meant a nightly job could
// hammer the real mail account with thousands of sends until the provider throttled it - which then blocked real mail
// (a credentials email, a password reset). They are logged and skipped, in every environment.
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost']);
const RESERVED_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);

export function isUndeliverableAddress(address: string): boolean {
  const domain = address.trim().toLowerCase().split('@').pop() ?? '';
  if (!domain) return true;
  if (RESERVED_DOMAINS.has(domain)) return true;
  const tld = domain.split('.').pop() ?? '';
  return RESERVED_TLDS.has(tld);
}

// How long SMTP sends pause after the provider says it is throttling or rejecting the login. Retrying every message
// in the meantime only extends the lock.
const SMTP_PAUSE_MS = 10 * 60 * 1000;

// Which provider actually sends the mail. Same opt-in-driver convention as
// FILE_STORAGE_DRIVER=s3 — unset/anything-else keeps the existing SMTP (or
// dry-run-to-console when unconfigured) behavior untouched; only an
// explicit EMAIL_DRIVER=resend switches providers.
function emailDriver(): 'resend' | 'smtp' {
  return process.env.EMAIL_DRIVER === 'resend' ? 'resend' : 'smtp';
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private resend: Resend | null = null;
  // Set when the SMTP provider throttles / refuses the login; sends are skipped (and logged) until it passes.
  private smtpPausedUntil = 0;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
  ) {}

  // Resend-only — the SMTP driver has no per-org verified-domain concept
  // (an arbitrary relay has no DNS-verification API), so this always
  // falls through to the shared platform address there. Falls back to the
  // shared address for any org that never verified a domain, or whose
  // verification hasn't completed yet.
  private async resolveFrom(organizationId?: string): Promise<string> {
    const platformDefault =
      process.env.EMAIL_FROM || 'no-reply@dbuggedprogrammers.com';
    if (!organizationId || emailDriver() !== 'resend') return platformDefault;
    const org = await this.prisma.organization
      .findUnique({
        where: { id: organizationId },
        select: { emailSendingAddress: true, emailDomainStatus: true },
      })
      .catch(() => null);
    if (org?.emailDomainStatus === 'verified' && org.emailSendingAddress) {
      return org.emailSendingAddress;
    }
    return platformDefault;
  }

  private getTransporter(): nodemailer.Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
        // Without pooling, every send() opens a brand-new TCP+TLS handshake and re-authenticates
        // from scratch — slow on its own, and serializes back-to-back sends (e.g. a payroll run
        // emailing many employees) into one connection at a time. Pooling keeps up to 5 authenticated
        // connections warm and reuses them, and rate-limits to stay under Gmail's per-second cap.
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
        rateDelta: 1000,
        rateLimit: 5,
        // nodemailer's defaults are 2 min to connect and 10 min of silence, so an unreachable mail server could hold
        // any request that awaits a send for minutes. Bound each stage instead; callers treat a failed send as
        // best-effort.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    }
    return this.transporter;
  }

  private getResend(): Resend {
    if (!this.resend) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
    }
    return this.resend;
  }

  // Whether a real delivery channel is set up (Resend key, or SMTP credentials). Without one send() only logs a dry
  // run - fine for a notification, not for something the recipient must act on (a sign-up confirmation link).
  isConfigured(): boolean {
    if (emailDriver() === 'resend') return !!process.env.RESEND_API_KEY;
    return !!process.env.SMTP_USER && !!process.env.SMTP_PASS;
  }

  async send({
    to,
    subject,
    html,
    cc,
    attachments,
    organizationId,
  }: SendEmailInput): Promise<{ dryRun: boolean }> {
    const attachmentNote = attachments?.length
      ? ` | Attachments: ${attachments.map((a) => a.filename).join(', ')}`
      : '';
    const ccNote = cc?.length ? ` | Cc: ${cc.join(', ')}` : '';
    const from = await this.resolveFrom(organizationId);

    // An address that cannot exist: never handed to a provider.
    if (isUndeliverableAddress(to)) {
      this.logger.log(
        `[Email - SKIPPED, reserved test address] To: ${to} | Subject: ${subject}${attachmentNote}`,
      );
      return { dryRun: true };
    }

    if (emailDriver() === 'resend') {
      if (!process.env.RESEND_API_KEY) {
        this.logger.log(
          `[Email - DRY RUN, EMAIL_DRIVER=resend but RESEND_API_KEY not set] To: ${to}${ccNote} | Subject: ${subject}${attachmentNote} | Body not logged (may contain credentials)`,
        );
        return { dryRun: true };
      }
      try {
        const { error } = await this.getResend().emails.send({
          from,
          to,
          subject,
          html,
          ...(cc?.length && { cc }),
          attachments: attachments?.map((a) => ({
            filename: a.filename,
            content: a.content,
          })),
        });
        if (error) throw new Error(error.message);
        return { dryRun: false };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[Email] Resend failed to send to ${to} (Subject: ${subject}). Body not logged (may contain credentials). Resend error: ${message}`,
        );
        return { dryRun: true };
      }
    }

    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      this.logger.log(
        `[Email - DRY RUN, SMTP not configured] To: ${to}${ccNote} | Subject: ${subject}${attachmentNote} | Body not logged (may contain credentials)`,
      );
      return { dryRun: true };
    }

    if (Date.now() < this.smtpPausedUntil) {
      this.logger.warn(
        `[Email - PAUSED, the mail provider refused the login a moment ago] To: ${to} | Subject: ${subject}${attachmentNote}`,
      );
      return { dryRun: true };
    }

    try {
      await this.getTransporter().sendMail({
        from,
        to,
        subject,
        html,
        ...(cc?.length && { cc }),
        attachments,
      });
      return { dryRun: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Email] Failed to send to ${to} (Subject: ${subject}). Body not logged (may contain credentials). SMTP error: ${message}`,
      );
      // A login refusal / "too many login attempts" is not about this message: stop sending for a while so a batch
      // does not keep hitting the provider and deepen the lock.
      const code = (err as { code?: string; responseCode?: number }).code;
      const responseCode = (err as { responseCode?: number }).responseCode;
      if (
        code === 'EAUTH' ||
        responseCode === 454 ||
        responseCode === 535 ||
        /too many login attempts/i.test(message)
      ) {
        this.smtpPausedUntil = Date.now() + SMTP_PAUSE_MS;
        this.logger.warn(
          `[Email] SMTP sends paused for ${SMTP_PAUSE_MS / 60000} minutes after a login refusal.`,
        );
      }
      return { dryRun: true };
    }
  }
}
