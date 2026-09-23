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
      return { dryRun: true };
    }
  }
}
