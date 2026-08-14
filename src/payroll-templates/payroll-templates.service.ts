import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PayrollTemplate } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreatePayrollTemplateDto } from './dto/create-payroll-template.dto';
import { UpdatePayrollTemplateDto } from './dto/update-payroll-template.dto';

@Injectable()
export class PayrollTemplatesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  findAll(organizationId: string) {
    return this.scopedPrisma.payrollTemplate.findMany({
      where: { organizationId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
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
