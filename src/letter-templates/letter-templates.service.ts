// Purpose: Org-scoped, admin/HR-authored letter templates — Offer Letter/Appointment Letter/Relieving
//   Letter/Experience Letter/Experience Certificate/Salary Certificate/Full & Final Settlement start
//   seeded (isCustom: false), fully editable; an admin can also create entirely new custom letter types.
// Responsibilities: Owns seedDefaults() (called from AuthService.register()'s transaction, same
//   integration point as EmailTemplatesService) and CRUD; LettersService reads via findActiveByKey() and
//   renders with render() — same pure {{key}} substitution email templates already use.
// Important: key is a free-form string (not an enum) — it doubles as the Document Numbering entry name
//   (organizations/document-numbering.ts already accepts an arbitrary key) and the letters download route
//   param, so create() also seeds a Document Numbering entry for a brand-new key, and delete() removes it.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditModule, LetterDataProfile, Prisma } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { UpdateLetterTemplateDto } from './dto/update-letter-template.dto';
import { CreateLetterTemplateDto } from './dto/create-letter-template.dto';
import { LETTER_TEMPLATE_DEFAULTS } from './letter-template-defaults';
import { renderTemplate } from '../email-templates/render-template';
import { wrapAll } from '../common/pagination';

interface DocumentNumberingEntry {
  label: string;
  format: string;
  resetRule: 'never' | 'monthly' | 'yearly';
  counter: number;
  lastPeriodKey: string | null;
}

// Mirrors defaultEntry() in organizations/document-numbering.ts, just with
// a readable label/prefix derived from the template's own name instead of
// the raw key — so a brand-new custom template shows up nicely in
// Organization Settings > Document Numbering immediately, with no extra
// step for the admin.
function seededNumberingEntry(name: string): DocumentNumberingEntry {
  const prefix =
    name
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 4) || 'LT';
  return {
    label: name,
    format: `${prefix}-{DD_MM_YYYY}-{00001}`,
    resetRule: 'yearly',
    counter: 0,
    lastPeriodKey: null,
  };
}

@Injectable()
export class LetterTemplatesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  // Every new org starts with the 7 built-in letter types instead of an
  // empty Letter Templates page — same registration-time integration
  // point as EmailTemplatesService.seedDefaults, and the same
  // Document Numbering entries already exist on Organization.
  // documentNumbering's own schema default, so no numbering seeding is
  // needed here (unlike create() below, for a genuinely new key).
  async seedDefaults(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    for (const def of LETTER_TEMPLATE_DEFAULTS) {
      await tx.letterTemplate.create({
        data: {
          organizationId,
          key: def.key,
          name: def.name,
          title: def.title,
          addressedToEmployee: def.addressedToEmployee,
          dataProfile: def.dataProfile,
          bodyText: def.bodyText,
          isCustom: false,
        },
      });
    }
  }

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.letterTemplate.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
    return wrapAll(data);
  }

  async findByKey(key: string, organizationId: string) {
    return this.findByKeyOrThrow(key, organizationId);
  }

  // Looks up the org's active template for a key, or null — LettersService
  // falls back to a clear "not configured" error rather than a generic
  // 404 when this returns null.
  async findActiveByKey(key: string, organizationId: string) {
    return this.scopedPrisma.letterTemplate.findFirst({
      where: { organizationId, key, isActive: true },
    });
  }

  private async uniqueKey(
    name: string,
    organizationId: string,
  ): Promise<string> {
    const words = name
      .trim()
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean);
    const base =
      words
        .map((w, i) =>
          i === 0
            ? w.toLowerCase()
            : w[0].toUpperCase() + w.slice(1).toLowerCase(),
        )
        .join('') || 'customLetter';
    let candidate = base;
    let suffix = 2;
    while (
      await this.scopedPrisma.letterTemplate.findFirst({
        where: { organizationId, key: candidate },
      })
    ) {
      candidate = `${base}${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  async create(
    dto: CreateLetterTemplateDto,
    organizationId: string,
    actorId?: string,
  ) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Template name is required.');
    const key = await this.uniqueKey(name, organizationId);

    const template = await this.scopedPrisma.letterTemplate.create({
      data: {
        organizationId,
        key,
        name,
        title: dto.title,
        bodyText: dto.bodyText,
        addressedToEmployee: dto.addressedToEmployee ?? true,
        dataProfile: dto.dataProfile ?? LetterDataProfile.BASIC,
        isCustom: true,
      },
    });

    // Seed this key's Document Numbering entry so it appears (with a
    // readable label, not the raw key) in Organization Settings >
    // Document Numbering immediately — issueDocumentNumber() would
    // otherwise only create one lazily, on first generation, with a less
    // readable default label.
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { documentNumbering: true },
    });
    const numbering = (org?.documentNumbering ?? {}) as Record<string, unknown>;
    if (!(key in numbering)) {
      await this.scopedPrisma.organization.update({
        where: { id: organizationId },
        data: {
          documentNumbering: {
            ...numbering,
            [key]: seededNumberingEntry(name),
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'LETTER_TEMPLATE_CREATED',
        module: AuditModule.DOCUMENT,
        organizationId,
        targetId: template.id,
        details: { name: template.name, key },
      });
    }

    return template;
  }

  async update(
    id: string,
    dto: UpdateLetterTemplateDto,
    organizationId: string,
    actorId?: string,
  ) {
    const existing = await this.scopedPrisma.letterTemplate.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new NotFoundException('Letter template not found.');

    await this.scopedPrisma.letterTemplate.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.bodyText !== undefined && { bodyText: dto.bodyText }),
        ...(dto.addressedToEmployee !== undefined && {
          addressedToEmployee: dto.addressedToEmployee,
        }),
        // See UpdateLetterTemplateDto's comment — a built-in template's
        // data profile is load-bearing, so an edit can't change it.
        ...(dto.dataProfile !== undefined &&
          existing.isCustom && { dataProfile: dto.dataProfile }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'LETTER_TEMPLATE_UPDATED',
        module: AuditModule.DOCUMENT,
        organizationId,
        targetId: id,
        details: {
          key: existing.key,
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
      });
    }

    return this.scopedPrisma.letterTemplate.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  async delete(id: string, organizationId: string, actorId?: string) {
    const template = await this.scopedPrisma.letterTemplate.findFirst({
      where: { id, organizationId },
    });
    if (!template) throw new NotFoundException('Letter template not found.');
    if (!template.isCustom) {
      throw new BadRequestException(
        'Built-in letter templates can’t be deleted — disable them instead.',
      );
    }

    await this.scopedPrisma.letterTemplate.deleteMany({
      where: { id, organizationId },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'LETTER_TEMPLATE_DELETED',
        module: AuditModule.DOCUMENT,
        organizationId,
        targetId: id,
        details: { name: template.name, key: template.key },
      });
    }

    return { success: true, message: 'Letter template deleted' };
  }

  // Pure {{key}} substitution — see email-templates/render-template.ts.
  // Reused directly rather than duplicated; letters aren't emails, but the
  // substitution rule (unmatched placeholder left as literal text) is
  // identical.
  render(template: string, variables: Record<string, string>): string {
    return renderTemplate(template, variables);
  }

  private async findByKeyOrThrow(key: string, organizationId: string) {
    const template = await this.scopedPrisma.letterTemplate.findFirst({
      where: { organizationId, key },
    });
    if (!template) {
      throw new NotFoundException(`No letter template found for key '${key}'.`);
    }
    return template;
  }
}
