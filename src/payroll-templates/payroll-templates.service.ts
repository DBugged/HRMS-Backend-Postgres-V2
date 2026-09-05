// Purpose: CRUD for payslip PDF templates (branding/layout options) and default-template management.
// Responsibilities: Owns the single-default-per-org invariant (unsetOtherDefaults on create/setDefault) and
// preview generation, delegating actual PDF rendering to PayslipPdfService.
// Important: previewDraft() merges an unsaved editor draft over DRAFT_DEFAULTS (mirroring the Prisma column
// defaults) so the rendered preview always has every field the PDF layout reads, even for a brand-new
// session. isDefault is deliberately excluded from UpdatePayrollTemplateDto — only setDefault() may flip it.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  HeaderStyle,
  PayrollTemplate,
  PayslipFontFamily,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreatePayrollTemplateDto } from './dto/create-payroll-template.dto';
import { UpdatePayrollTemplateDto } from './dto/update-payroll-template.dto';
import { PayslipPdfService } from '../payroll/payslip-pdf.service';
import { wrapAll } from '../common/pagination';
import { AuditLogService } from '../audit-log/audit-log.service';
import { signFileToken, resolveIncomingFileValue } from '../files/file-token';

// Defaults for whatever the "draft" preview body leaves unset — mirrors the
// Prisma column defaults so the rendered preview always has every field the
// PDF layout reads, even from a brand-new, never-saved editor session.
const DRAFT_DEFAULTS: PayrollTemplate = {
  id: 'preview',
  organizationId: '',
  name: 'New Template',
  isDefault: false,
  companyLogoUrl: null,
  // Neutral placeholder, not this platform's own name — matches the
  // Prisma column default (see schema.prisma's comment on
  // PayrollTemplate.companyName); a brand-new/never-saved preview
  // session with no companyName typed yet must not print this
  // platform's identity on what could become another org's real payslip.
  companyName: 'Your Company Name',
  companyAddress: null,
  companyEmail: null,
  companyWebsite: null,
  companyContactNumber: null,
  primaryColor: '#5546e0',
  secondaryColor: '#14161d',
  accentColor: '#10b981',
  footerText: null,
  signatoryName: null,
  signatoryDesignation: null,
  watermarkText: null,
  headerStyle: HeaderStyle.MODERN,
  headerColor: null,
  fontFamily: PayslipFontFamily.HELVETICA,
  fontSize: 9,
  showCompanyAddress: true,
  showPAN: true,
  showUAN: true,
  showESIC: true,
  showPFNumber: true,
  showBankDetails: true,
  showEmployerContributions: true,
  showCTC: true,
  showYTD: true,
  showQRCode: true,
  showFooter: true,
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

@Injectable()
export class PayrollTemplatesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly payslipPdfService: PayslipPdfService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.payrollTemplate.findMany({
      where: { organizationId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return wrapAll(data.map((t) => this.withSignedLogo(t)));
  }

  async findOne(id: string, organizationId: string) {
    return this.withSignedLogo(await this.findByIdOrThrow(id, organizationId));
  }

  // companyLogoUrl is stored as a durable relativeKey (same convention as
  // Organization.companyLogoUrl — see organization-settings.service.ts's
  // withSignedUrls), never a signed URL — signing only ever happens here,
  // fresh on every read, so a template saved once doesn't end up with a
  // logo link that silently expires and 404s weeks later.
  private withSignedLogo(template: PayrollTemplate): PayrollTemplate {
    if (!template.companyLogoUrl) return template;
    return {
      ...template,
      companyLogoUrl: `/files/${signFileToken(template.organizationId, template.companyLogoUrl)}`,
    };
  }

  async create(
    dto: CreatePayrollTemplateDto,
    createdById: string,
    organizationId: string,
  ) {
    const count = await this.scopedPrisma.payrollTemplate.count({
      where: { organizationId },
    });
    const isFirst = count === 0;

    // See resolveIncomingFileValue's comment — dto.companyLogoUrl is
    // whatever the client's form state held, which is a signed (expiring)
    // URL unless the logo was *just* freshly uploaded this session.
    const companyLogoUrl = resolveIncomingFileValue(
      organizationId,
      dto.companyLogoUrl ?? null,
      null,
    );

    const template = await this.scopedPrisma.payrollTemplate.create({
      data: {
        ...dto,
        companyLogoUrl,
        organizationId,
        isDefault: isFirst ? true : (dto.isDefault ?? false),
        createdById,
      },
    });

    if (template.isDefault) {
      await this.unsetOtherDefaults(template.id, organizationId);
    }

    await this.auditLogService.log({
      actorId: createdById,
      action: 'PAYROLL_TEMPLATE_CREATED',
      module: 'PAYROLL',
      organizationId,
      targetId: template.id,
      details: { name: template.name },
    });

    return this.withSignedLogo(template);
  }

  async update(
    id: string,
    dto: UpdatePayrollTemplateDto,
    organizationId: string,
    actorId?: string,
  ) {
    const existing = await this.findByIdOrThrow(id, organizationId);
    // isDefault is deliberately absent from UpdatePayrollTemplateDto — only
    // setDefault() can flip it, matching the old controller.
    // See resolveIncomingFileValue's comment on why this can't just trust
    // dto.companyLogoUrl as-is.
    const data =
      'companyLogoUrl' in dto
        ? {
            ...dto,
            companyLogoUrl: resolveIncomingFileValue(
              organizationId,
              dto.companyLogoUrl ?? null,
              existing.companyLogoUrl,
            ),
          }
        : dto;
    await this.scopedPrisma.payrollTemplate.updateMany({
      where: { id, organizationId },
      data,
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'PAYROLL_TEMPLATE_UPDATED',
        module: 'PAYROLL',
        organizationId,
        targetId: id,
      });
    }

    return this.withSignedLogo(await this.findByIdOrThrow(id, organizationId));
  }

  async remove(id: string, organizationId: string, actorId?: string) {
    const template = await this.findByIdOrThrow(id, organizationId);
    if (template.isDefault) {
      throw new BadRequestException(
        'Cannot delete the default template — set another template as default first.',
      );
    }
    await this.scopedPrisma.payrollTemplate.deleteMany({
      where: { id, organizationId },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'PAYROLL_TEMPLATE_DELETED',
        module: 'PAYROLL',
        organizationId,
        targetId: id,
        details: { name: template.name },
      });
    }

    return { message: 'Template deleted' };
  }

  async setDefault(id: string, organizationId: string, actorId?: string) {
    await this.findByIdOrThrow(id, organizationId);
    await this.unsetOtherDefaults(id, organizationId);
    await this.scopedPrisma.payrollTemplate.updateMany({
      where: { id, organizationId },
      data: { isDefault: true },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'PAYROLL_TEMPLATE_SET_DEFAULT',
        module: 'PAYROLL',
        organizationId,
        targetId: id,
      });
    }

    return this.withSignedLogo(await this.findByIdOrThrow(id, organizationId));
  }

  async previewDraft(dto: CreatePayrollTemplateDto, organizationId: string) {
    const merged: PayrollTemplate = {
      ...DRAFT_DEFAULTS,
      ...dto,
      organizationId,
    };
    return this.payslipPdfService.buildPreviewPdfBuffer(merged, organizationId);
  }

  async previewSaved(id: string, organizationId: string) {
    const template = await this.findByIdOrThrow(id, organizationId);
    return this.payslipPdfService.buildPreviewPdfBuffer(
      template,
      organizationId,
    );
  }

  private async unsetOtherDefaults(exceptId: string, organizationId: string) {
    await this.scopedPrisma.payrollTemplate.updateMany({
      where: { organizationId, id: { not: exceptId }, isDefault: true },
      data: { isDefault: false },
    });
  }

  private async findByIdOrThrow(
    id: string,
    organizationId: string,
  ): Promise<PayrollTemplate> {
    const template = await this.scopedPrisma.payrollTemplate.findFirst({
      where: { id, organizationId },
    });
    if (!template) throw new NotFoundException('Payroll template not found.');
    return template;
  }
}
