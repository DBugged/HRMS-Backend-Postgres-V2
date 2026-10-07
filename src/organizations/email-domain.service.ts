// Purpose: Per-org custom email sending domain, verified by proving domain ownership via a DNS TXT
//   record — no third-party API or API key required. Once verified, EmailService sends notifications
//   "from" the org's own address instead of the shared platform one.
// Responsibilities: starts verification (generates a token and returns the TXT record the org must
//   add at their own DNS provider), re-checks status on demand by looking the record up over public
//   DNS, and lets an org reset/remove it.
// Important: proves domain *ownership* only (DNS control) — it does not configure SPF/DKIM/DMARC for
//   actually sending as that domain over SMTP. The org's mail/DNS provider is responsible for that,
//   same as before. See email.service.ts's resolveFrom(), which only consults emailDomainStatus.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { promises as dns } from 'dns';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

const RECORD_PREFIX = '_hrms-verify';
const VALUE_PREFIX = 'hrms-verify=';

function extractDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) {
    throw new BadRequestException(
      'Enter a full email address, e.g. hr@yourcompany.com.',
    );
  }
  return email.slice(at + 1).toLowerCase();
}

function recordNameFor(domain: string): string {
  return `${RECORD_PREFIX}.${domain}`;
}

@Injectable()
export class EmailDomainService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  // Distinguishes "no TXT record published yet" (not added, or added but not
  // propagated — recoverable, admin should just wait/retry) from "a record
  // is published but its value doesn't match" (a real mismatch — wrong
  // token, stale record from a previous attempt, or copy-paste error).
  private async lookupToken(
    domain: string,
  ): Promise<{ found: false } | { found: true; token: string | null }> {
    let records: string[][];
    try {
      records = await dns.resolveTxt(recordNameFor(domain));
    } catch {
      // Covers ENODATA/ENOTFOUND (no record published/propagated yet) and
      // any other resolver failure (timeout, SERVFAIL) — all recoverable,
      // the org did nothing wrong and retrying may well succeed.
      return { found: false };
    }
    for (const chunks of records) {
      const value = chunks.join('');
      if (value.startsWith(VALUE_PREFIX)) {
        return { found: true, token: value.slice(VALUE_PREFIX.length) };
      }
    }
    // The _hrms-verify subdomain resolves, but none of its TXT values carry
    // our prefix — e.g. only an unrelated TXT record exists there.
    return { found: true, token: null };
  }

  private recordFor(domain: string, token: string) {
    return {
      type: 'TXT',
      name: recordNameFor(domain),
      value: `${VALUE_PREFIX}${token}`,
    };
  }

  async getStatus(organizationId: string) {
    const org = await this.scopedPrisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: {
        emailSendingAddress: true,
        emailDomainVerificationToken: true,
        emailDomainStatus: true,
      },
    });
    if (!org.emailDomainVerificationToken || !org.emailSendingAddress) {
      return {
        emailSendingAddress: null,
        status: 'not_started',
        records: [],
      };
    }
    const domain = extractDomain(org.emailSendingAddress);
    return {
      emailSendingAddress: org.emailSendingAddress,
      status: org.emailDomainStatus,
      records: [this.recordFor(domain, org.emailDomainVerificationToken)],
    };
  }

  async startVerification(organizationId: string, email: string) {
    const domain = extractDomain(email);
    const token = randomBytes(16).toString('hex');
    await this.scopedPrisma.organization.updateMany({
      where: { id: organizationId },
      data: {
        emailSendingAddress: email,
        emailDomainVerificationToken: token,
        emailDomainStatus: 'pending',
      },
    });
    return {
      emailSendingAddress: email,
      status: 'pending',
      records: [this.recordFor(domain, token)],
    };
  }

  async recheckVerification(organizationId: string) {
    const org = await this.scopedPrisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: {
        emailDomainVerificationToken: true,
        emailSendingAddress: true,
      },
    });
    if (!org.emailDomainVerificationToken || !org.emailSendingAddress) {
      throw new NotFoundException(
        'No email sending domain has been started for this organization yet.',
      );
    }
    const domain = extractDomain(org.emailSendingAddress);
    const result = await this.lookupToken(domain);

    let status: string;
    let message: string;
    if (!result.found) {
      status = 'pending';
      message =
        'No TXT record was found yet. DNS changes can take a few minutes ' +
        '(sometimes longer) to propagate — add the record if you haven\'t ' +
        'already, then try again shortly.';
    } else if (result.token === org.emailDomainVerificationToken) {
      status = 'verified';
      message = 'Domain ownership verified.';
    } else {
      status = 'failed';
      message =
        'A TXT record was found at ' +
        recordNameFor(domain) +
        ", but its value doesn't match what we expected. Make sure you " +
        "copied the value exactly and haven't added it more than once.";
    }

    await this.scopedPrisma.organization.updateMany({
      where: { id: organizationId },
      data: { emailDomainStatus: status },
    });
    return {
      emailSendingAddress: org.emailSendingAddress,
      status,
      message,
      records: [this.recordFor(domain, org.emailDomainVerificationToken)],
    };
  }

  async remove(organizationId: string) {
    await this.scopedPrisma.organization.updateMany({
      where: { id: organizationId },
      data: {
        emailSendingAddress: null,
        emailDomainVerificationToken: null,
        emailDomainStatus: 'not_started',
      },
    });
    return { emailSendingAddress: null, status: 'not_started', records: [] };
  }
}
