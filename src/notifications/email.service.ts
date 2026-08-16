import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Resend } from 'resend';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

// Strips HTML tags for a console-readable fallback body — used whenever the
// email can't actually be delivered (SMTP unconfigured, or the send fails),
// so time-sensitive content is never silently lost, only the delivery
// channel. Ported verbatim from the old system's sendEmail.js.
function stripHtml(html: string): string {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
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
    attachments,
  }: SendEmailInput): Promise<{ dryRun: boolean }> {
    const attachmentNote = attachments?.length
      ? ` | Attachments: ${attachments.map((a) => a.filename).join(', ')}`
      : '';
    const from = process.env.EMAIL_FROM || 'no-reply@dbuggedprogrammers.com';

    if (emailDriver() === 'resend') {
      if (!process.env.RESEND_API_KEY) {
        this.logger.log(
          `[Email - DRY RUN, EMAIL_DRIVER=resend but RESEND_API_KEY not set] To: ${to} | Subject: ${subject}${attachmentNote}\n${stripHtml(html)}`,
        );
        return { dryRun: true };
      }
      try {
        const { error } = await this.getResend().emails.send({
          from,
          to,
          subject,
          html,
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
          `[Email] Resend failed to send to ${to} (Subject: ${subject}). Delivering content to console instead so it isn't lost:\n${stripHtml(html)}\nResend error: ${message}`,
        );
        return { dryRun: true };
      }
    }

    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      this.logger.log(
        `[Email - DRY RUN, SMTP not configured] To: ${to} | Subject: ${subject}${attachmentNote}\n${stripHtml(html)}`,
      );
      return { dryRun: true };
    }

    try {
      await this.getTransporter().sendMail({
        from,
        to,
        subject,
        html,
        attachments,
      });
      return { dryRun: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Email] Failed to send to ${to} (Subject: ${subject}). Delivering content to console instead so it isn't lost:\n${stripHtml(html)}\nSMTP error: ${message}`,
      );
      return { dryRun: true };
    }
  }
}
