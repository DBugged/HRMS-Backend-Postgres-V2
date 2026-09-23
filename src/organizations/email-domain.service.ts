// Purpose: Per-org custom email sending domain, verified via Resend's Domains API — once verified,
//   EmailService sends notifications "from" the org's own address instead of the shared platform one.
// Responsibilities: starts verification (creates the Resend domain, returns the DNS records the org
//   must add at their own DNS provider), re-checks status on demand, and lets an org reset/remove it.
// Important: Resend-only. EMAIL_DRIVER=smtp orgs have no equivalent (an arbitrary SMTP relay has no
//   DNS-domain-verification API to call), so this whole feature is a no-op for them — see
//   email.service.ts's resolveFrom(), which only consults emailDomainStatus on the Resend path.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Resend } from 'resend';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

function extractDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) {
    throw new BadRequestException(
      'Enter a full email address, e.g. hr@yourcompany.com.',
    );
  }
  return email.slice(at + 1).toLowerCase();
}

@Injectable()
export class EmailDomainService {
  private resend: Resend | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  private getResend(): Resend {
    if (!process.env.RESEND_API_KEY) {
      throw new BadRequestException(
        'Email sending domain verification is not available on this deployment.',
      );
    }
    if (!this.resend) this.resend = new Resend(process.env.RESEND_API_KEY);
    return this.resend;
  }

  async getStatus(organizationId: string) {
    const org = await this.scopedPrisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: {
        emailSendingAddress: true,
        resendDomainId: true,
        emailDomainStatus: true,
      },
    });
    if (!org.resendDomainId) {
      return {
        emailSendingAddress: null,
        status: 'not_started',
        records: [],
      };
    }
    // Live from Resend rather than the cached DB column, so a DNS record
    // the org just added shows as verified without a separate "refresh"
    // step being required first.
    const { data, error } = await this.getResend().domains.get(
      org.resendDomainId,
    );
    if (error || !data) {
      return {
        emailSendingAddress: org.emailSendingAddress,
        status: org.emailDomainStatus,
        records: [],
      };
    }
    if (data.status !== org.emailDomainStatus) {
      await this.scopedPrisma.organization.updateMany({
        where: { id: organizationId },
        data: { emailDomainStatus: data.status },
      });
    }
    return {
      emailSendingAddress: org.emailSendingAddress,
      status: data.status,
      records: data.records,
    };
  }

  async startVerification(organizationId: string, email: string) {
    const domain = extractDomain(email);
    const { data, error } = await this.getResend().domains.create({
      name: domain,
    });
    if (error || !data) {
      throw new BadRequestException(
        error?.message ||
          'Failed to start domain verification with the email provider.',
      );
    }
    await this.scopedPrisma.organization.updateMany({
      where: { id: organizationId },
      data: {
        emailSendingAddress: email,
        resendDomainId: data.id,
        emailDomainStatus: data.status,
      },
    });
    return {
      emailSendingAddress: email,
      status: data.status,
      records: data.records,
    };
  }

  async recheckVerification(organizationId: string) {
    const org = await this.scopedPrisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { resendDomainId: true, emailSendingAddress: true },
    });
    if (!org.resendDomainId) {
      throw new NotFoundException(
        'No email sending domain has been started for this organization yet.',
      );
    }
    await this.getResend().domains.verify(org.resendDomainId);
    const { data, error } = await this.getResend().domains.get(
      org.resendDomainId,
    );
    if (error || !data) {
      throw new BadRequestException(
        error?.message || 'Failed to check verification status.',
      );
    }
    await this.scopedPrisma.organization.updateMany({
      where: { id: organizationId },
      data: { emailDomainStatus: data.status },
    });
    return {
      emailSendingAddress: org.emailSendingAddress,
      status: data.status,
      records: data.records,
    };
  }

  async remove(organizationId: string) {
    const org = await this.scopedPrisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { resendDomainId: true },
    });
    if (org.resendDomainId) {
      // Best-effort — even if Resend-side removal fails (e.g. already
      // gone), the org must still be able to clear its own local state.
      await this.getResend()
        .domains.remove(org.resendDomainId)
        .catch(() => {});
    }
    await this.scopedPrisma.organization.updateMany({
      where: { id: organizationId },
      data: {
        emailSendingAddress: null,
        resendDomainId: null,
        emailDomainStatus: 'not_started',
      },
    });
    return { emailSendingAddress: null, status: 'not_started', records: [] };
  }
}
