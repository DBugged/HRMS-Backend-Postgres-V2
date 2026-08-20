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

// Defaults for whatever the "draft" preview body leaves unset — mirrors the
// Prisma column defaults so the rendered preview always has every field the
// PDF layout reads, even from a brand-new, never-saved editor session.
const DRAFT_DEFAULTS: PayrollTemplate = {
  id: 'preview',
  organizationId: '',
  name: 'New Template',
  isDefault: false,
  companyLogoUrl: null,
  companyName: "D'Bugged Programmers",
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
  ) {}

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.payrollTemplate.findMany({
      where: { organizationId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return wrapAll(data);
  }

  async findOne(id: string, organizationId: string) {
    return this.findByIdOrThrow(id, organizationId);
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

    const template = await this.scopedPrisma.payrollTemplate.create({
      data: {
        ...dto,
        organizationId,
        isDefault: isFirst ? true : (dto.isDefault ?? false),
        createdById,
      },
    });

    if (template.isDefault) {
      await this.unsetOtherDefaults(template.id, organizationId);
    }
    return template;
  }

  async update(
    id: string,
    dto: UpdatePayrollTemplateDto,
    organizationId: string,
  ) {
    await this.findByIdOrThrow(id, organizationId);
    // isDefault is deliberately absent from UpdatePayrollTemplateDto — only
    // setDefault() can flip it, matching the old controller.
    await this.scopedPrisma.payrollTemplate.updateMany({
      where: { id, organizationId },
      data: dto,
    });
    return this.findByIdOrThrow(id, organizationId);
  }

  async remove(id: string, organizationId: string) {
    const template = await this.findByIdOrThrow(id, organizationId);
    if (template.isDefault) {
      throw new BadRequestException(
        'Cannot delete the default template — set another template as default first.',
      );
    }
    await this.scopedPrisma.payrollTemplate.deleteMany({
      where: { id, organizationId },
    });
    return { message: 'Template deleted' };
  }

  async setDefault(id: string, organizationId: string) {
    await this.findByIdOrThrow(id, organizationId);
    await this.unsetOtherDefaults(id, organizationId);
    await this.scopedPrisma.payrollTemplate.updateMany({
      where: { id, organizationId },
      data: { isDefault: true },
    });
    return this.findByIdOrThrow(id, organizationId);
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
