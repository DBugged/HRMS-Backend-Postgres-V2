import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

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

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;

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

  async send({
    to,
    subject,
    html,
    attachments,
  }: SendEmailInput): Promise<{ dryRun: boolean }> {
    const attachmentNote = attachments?.length
      ? ` | Attachments: ${attachments.map((a) => a.filename).join(', ')}`
      : '';

    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      this.logger.log(
        `[Email - DRY RUN, SMTP not configured] To: ${to} | Subject: ${subject}${attachmentNote}\n${stripHtml(html)}`,
      );
      return { dryRun: true };
    }

    try {
      await this.getTransporter().sendMail({
        from: process.env.EMAIL_FROM || 'no-reply@dbuggedprogrammers.com',
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
