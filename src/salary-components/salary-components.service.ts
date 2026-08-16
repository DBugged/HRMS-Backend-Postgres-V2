import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CalcType, SalaryComponent } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreateSalaryComponentDto } from './dto/create-salary-component.dto';
import { UpdateSalaryComponentDto } from './dto/update-salary-component.dto';
import { ReorderSalaryComponentsDto } from './dto/reorder-salary-components.dto';
import { ValidateFormulaDto } from './dto/validate-formula.dto';
import { compileFormula, SYSTEM_VARS } from './formula-engine';
import { wrapAll } from '../common/pagination';
import {
  detectCircularReferences,
  isValidPercentage,
} from './salary-component-validation';

function slugify(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

@Injectable()
export class SalaryComponentsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  async create(
    dto: CreateSalaryComponentDto,
    createdById: string,
    organizationId: string,
  ) {
    this.assertValidPercentage(dto.calcType, dto.percentageValue);

    const code = (dto.code ? dto.code.toUpperCase() : slugify(dto.name)).trim();
    if (!code) {
      throw new BadRequestException(
        'Could not derive a code from the given name.',
      );
    }
    const existing = await this.scopedPrisma.salaryComponent.findFirst({
      where: { organizationId, code },
    });
    if (existing) {
      throw new ConflictException(
        `A component with code "${code}" already exists.`,
      );
    }

    const maxOrder = await this.scopedPrisma.salaryComponent.aggregate({
      where: { organizationId },
      _max: { displayOrder: true },
    });

    const active = await this.scopedPrisma.salaryComponent.findMany({
      where: { organizationId, isActive: true },
    });
    this.assertNoCircularReferences([
      ...active,
      {
        code,
        name: dto.name,
        calcType: dto.calcType ?? CalcType.FIXED,
        percentageOf: dto.percentageOf ?? null,
        formula: dto.formula ?? null,
      },
    ]);

    return this.scopedPrisma.salaryComponent.create({
      data: {
        organizationId,
        name: dto.name,
        code,
        type: dto.type,
        calcType: dto.calcType ?? CalcType.FIXED,
        percentageOf: dto.percentageOf,
        percentageValue: dto.percentageValue,
        formula: dto.formula,
        defaultValue: dto.defaultValue ?? 0,
        isTaxable: dto.isTaxable ?? true,
        includeInGross: dto.includeInGross ?? true,
        includeInNet: dto.includeInNet ?? true,
        includeInCTC: dto.includeInCTC ?? true,
        isEmployerContribution: dto.isEmployerContribution ?? false,
        showOnPayslip: dto.showOnPayslip ?? true,
        isStatutory: dto.isStatutory ?? false,
        statutoryKey: dto.statutoryKey,
        payFrequency: dto.payFrequency ?? 'MONTHLY',
        displayOrder: (maxOrder._max.displayOrder ?? -1) + 1,
        createdById,
      },
    });
  }

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.salaryComponent.findMany({
      where: { organizationId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return wrapAll(data);
  }

  validateFormula(dto: ValidateFormulaDto, organizationId: string) {
    try {
      const { referencedNames } = compileFormula(dto.formula);
      return this.scopedPrisma.salaryComponent
        .findMany({
          where: { organizationId, isActive: true },
          select: { code: true },
        })
        .then((components) => {
          const knownCodes = new Set(components.map((c) => c.code));
          if (dto.excludeCode) knownCodes.delete(dto.excludeCode);
          const systemVarSet = new Set<string>(SYSTEM_VARS);
          const unknownRefs = referencedNames.filter(
            (n) =>
              !knownCodes.has(n) &&
              !systemVarSet.has(n) &&
              n !== dto.excludeCode,
          );
          return {
            valid: true,
            referencedNames,
            unknownRefs,
            excludeCode: dto.excludeCode,
          };
        });
    } catch (err) {
      return Promise.resolve({ valid: false, error: (err as Error).message });
    }
  }

  async reorder(dto: ReorderSalaryComponentsDto, organizationId: string) {
    await Promise.all(
      dto.order.map(({ id, displayOrder }) =>
        this.scopedPrisma.salaryComponent.updateMany({
          where: { id, organizationId },
          data: { displayOrder },
        }),
      ),
    );
    return { success: true };
  }

  async update(
    id: string,
    dto: UpdateSalaryComponentDto,
    organizationId: string,
  ) {
    const existing = await this.findByIdOrThrow(id, organizationId);
    // code is immutable — stripped from the update payload even if sent.
    const calcType = dto.calcType ?? existing.calcType;
    const percentageValue =
      dto.percentageValue ?? existing.percentageValue ?? undefined;
    this.assertValidPercentage(calcType, percentageValue ?? undefined);

    const active = await this.scopedPrisma.salaryComponent.findMany({
      where: { organizationId, isActive: true },
    });
    const candidate = {
      code: existing.code,
      name: dto.name ?? existing.name,
      calcType,
      percentageOf:
        dto.percentageOf !== undefined
          ? (dto.percentageOf ?? null)
          : existing.percentageOf,
      formula:
        dto.formula !== undefined ? (dto.formula ?? null) : existing.formula,
    };
    this.assertNoCircularReferences([
      ...active.filter((c) => c.id !== id),
      candidate,
    ]);

    await this.scopedPrisma.salaryComponent.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.calcType !== undefined && { calcType: dto.calcType }),
        ...(dto.percentageOf !== undefined && {
          percentageOf: dto.percentageOf,
        }),
        ...(dto.percentageValue !== undefined && {
          percentageValue: dto.percentageValue,
        }),
        ...(dto.formula !== undefined && { formula: dto.formula }),
        ...(dto.defaultValue !== undefined && {
          defaultValue: dto.defaultValue,
        }),
        ...(dto.isTaxable !== undefined && { isTaxable: dto.isTaxable }),
        ...(dto.includeInGross !== undefined && {
          includeInGross: dto.includeInGross,
        }),
        ...(dto.includeInNet !== undefined && {
          includeInNet: dto.includeInNet,
        }),
        ...(dto.includeInCTC !== undefined && {
          includeInCTC: dto.includeInCTC,
        }),
        ...(dto.isEmployerContribution !== undefined && {
          isEmployerContribution: dto.isEmployerContribution,
        }),
        ...(dto.showOnPayslip !== undefined && {
          showOnPayslip: dto.showOnPayslip,
        }),
        ...(dto.isStatutory !== undefined && { isStatutory: dto.isStatutory }),
        ...(dto.statutoryKey !== undefined && {
          statutoryKey: dto.statutoryKey,
        }),
        ...(dto.payFrequency !== undefined && {
          payFrequency: dto.payFrequency,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    return this.findByIdOrThrow(id, organizationId);
  }

  async toggle(id: string, organizationId: string) {
    const existing = await this.findByIdOrThrow(id, organizationId);
    await this.scopedPrisma.salaryComponent.updateMany({
      where: { id, organizationId },
      data: { isActive: !existing.isActive },
    });
    return this.findByIdOrThrow(id, organizationId);
  }

  async remove(id: string, organizationId: string) {
    const existing = await this.findByIdOrThrow(id, organizationId);

    const inUse = await this.scopedPrisma.employeeSalaryComponent.count({
      where: { organizationId, componentCode: existing.code },
    });
    if (inUse > 0) {
      throw new ConflictException(
        "This component is assigned to one or more employees — disable it instead of deleting, or remove it from every employee's structure first.",
      );
    }

    await this.scopedPrisma.salaryComponent.deleteMany({
      where: { id, organizationId },
    });
    return { message: 'Component deleted' };
  }

  private assertValidPercentage(
    calcType: CalcType | undefined,
    percentageValue: number | undefined,
  ) {
    if (calcType !== CalcType.PERCENTAGE) return;
    if (!isValidPercentage(percentageValue)) {
      throw new BadRequestException(
        'percentageValue must be a number between 0 and 100.',
      );
    }
  }

  private assertNoCircularReferences(
    components: {
      code: string;
      name: string;
      calcType: CalcType;
      percentageOf: string | null;
      formula: string | null;
    }[],
  ) {
    try {
      detectCircularReferences(components);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  private async findByIdOrThrow(
    id: string,
    organizationId: string,
  ): Promise<SalaryComponent> {
    const component = await this.scopedPrisma.salaryComponent.findFirst({
      where: { id, organizationId },
    });
    if (!component) throw new NotFoundException('Salary component not found.');
    return component;
  }
}
