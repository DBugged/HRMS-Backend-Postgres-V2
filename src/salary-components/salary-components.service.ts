// Purpose: CRUD for org-defined SalaryComponent definitions (earnings/deductions/employer contributions)
// that drive payroll calculation.
// Responsibilities: Owns code derivation/uniqueness, display-order management, and circular-reference
// detection across every active component's percentage/formula references (assertNoCircularReferences);
// seedDefaults() is called from AuthService.register() to pre-populate the standard component catalog.
// Important: create()/update() both validate the candidate component against every OTHER active component
// before allowing a save, so a formula/percentage change can never introduce a reference cycle the payroll
// engine's topoSortComponents would then be unable to resolve. remove() blocks deletion while any employee
// has an override referencing this component's code — disable instead.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CalcType, Prisma, SalaryComponent } from '@prisma/client';
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
  isKnownFormulaReference,
  isValidPercentage,
  sampleEvaluationError,
} from './salary-component-validation';
import { SALARY_COMPONENT_DEFAULTS } from './salary-component-defaults';
import {
  STATUTORY_GATED_KEYS,
  statutoryEnabledToday,
} from './statutory-activation';
import { AuditLogService } from '../audit-log/audit-log.service';

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
    private readonly auditLogService: AuditLogService,
  ) {}

  // Every new org starts with the standard component set (Basic, HRA,
  // PF, ESI, PT, employer contributions, etc.) instead of an empty
  // Salary Components page and blank payslips — admin can edit/disable/
  // add to these afterward. Same registration-time integration point as
  // LeaveTypesService.seedDefaults / StatutoryConfigService.seedDefaults.
  async seedDefaults(
    tx: Prisma.TransactionClient,
    organizationId: string,
    createdById?: string,
  ): Promise<void> {
    for (const def of SALARY_COMPONENT_DEFAULTS) {
      await tx.salaryComponent.create({
        data: {
          ...def,
          organizationId,
          createdById,
          isSystemDefault: true,
        },
      });
    }
  }

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
    this.assertFormulaUsable(
      dto.calcType ?? CalcType.FIXED,
      dto.formula ?? null,
      active.map((c) => c.code),
    );

    const component = await this.scopedPrisma.salaryComponent.create({
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

    await this.auditLogService.log({
      actorId: createdById,
      action: 'SALARY_COMPONENT_CREATED',
      module: 'PAYROLL',
      organizationId,
      targetId: component.id,
      details: { code: component.code, name: component.name },
    });

    return component;
  }

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.salaryComponent.findMany({
      where: { organizationId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
    // Statutory components show as active only while their Statutory Compliance switch is on (display-only).
    const enabledToday = await statutoryEnabledToday(
      this.scopedPrisma,
      organizationId,
    );
    return wrapAll(
      data.map((c) =>
        c.statutoryKey && enabledToday.has(c.statutoryKey)
          ? { ...c, isActive: enabledToday.get(c.statutoryKey) === true }
          : c,
      ),
    );
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
          // Parsing alone used to be the whole check, so a formula that can
          // only ever produce NaN/Infinity was reported valid. Evaluate it
          // once against a representative context (every referenced name
          // gets a sample value — unknown references are still reported via
          // unknownRefs, as before).
          const evaluationError = sampleEvaluationError(dto.formula);
          if (evaluationError) {
            return { valid: false, error: evaluationError };
          }
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
    actorId?: string,
  ) {
    const existing = await this.findByIdOrThrow(id, organizationId);
    // code is immutable — stripped from the update payload even if sent.
    // A built-in's name is locked too — payslips/reports reference it by
    // the same reserved code (see reserved-codes.ts's SALARY_COMPONENT_CODES),
    // so relabeling "Provident Fund" to something else would be confusing
    // even though it wouldn't break the calculation itself. Custom
    // components' names stay freely editable.
    // SPECIAL_ALLOWANCE is the one exception: unlike PF/ESI/PT/etc. it's
    // not a statutory or reserved-code label (confirmed not referenced by
    // name anywhere in payroll/tax/reports — see reserved-codes.ts, which
    // never lists it), so it's safe to let orgs rename its display label
    // (e.g. to "Fixed Allowance") without the confusion this guard exists
    // to prevent for the genuinely statutory built-ins.
    if (
      existing.isSystemDefault &&
      existing.code !== 'SPECIAL_ALLOWANCE' &&
      dto.name !== undefined &&
      dto.name !== existing.name
    ) {
      throw new ConflictException(
        'This is a built-in salary component — its name cannot be changed.',
      );
    }
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
    // Only when the formula itself (or the calc type that makes it apply)
    // is being changed — an unrelated edit (e.g. the taxable flag) must not
    // start failing because some OTHER component this formula references has
    // since been deactivated.
    if (dto.formula !== undefined || dto.calcType !== undefined) {
      this.assertFormulaUsable(
        candidate.calcType,
        candidate.formula,
        active.filter((c) => c.id !== id).map((c) => c.code),
      );
    }

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
        ...(dto.displayOrder !== undefined && {
          displayOrder: dto.displayOrder,
        }),
      },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'SALARY_COMPONENT_UPDATED',
        module: 'PAYROLL',
        organizationId,
        targetId: id,
        details: { code: existing.code },
      });
    }

    return this.findByIdOrThrow(id, organizationId);
  }

  async toggle(id: string, organizationId: string) {
    const existing = await this.findByIdOrThrow(id, organizationId);
    // Statutory components follow their Statutory Compliance switch — flipping them here would
    // contradict it (and payroll), so the switch there is the only control.
    if (
      existing.statutoryKey &&
      STATUTORY_GATED_KEYS.includes(existing.statutoryKey)
    ) {
      throw new BadRequestException(
        `${existing.name} is controlled by Statutory Compliance — enable or disable it there.`,
      );
    }
    // Re-enabling puts the component back into the dependency graph. The
    // cycle check on create/update only ever saw the ACTIVE set, so
    // disable A -> point B at A -> re-enable A used to slip an A <-> B
    // cycle past it.
    if (!existing.isActive) {
      const active = await this.scopedPrisma.salaryComponent.findMany({
        where: { organizationId, isActive: true },
      });
      this.assertNoCircularReferences([
        ...active.filter((c) => c.id !== id),
        existing,
      ]);
    }
    await this.scopedPrisma.salaryComponent.updateMany({
      where: { id, organizationId },
      data: { isActive: !existing.isActive },
    });
    return this.findByIdOrThrow(id, organizationId);
  }

  async remove(id: string, organizationId: string, actorId?: string) {
    const existing = await this.findByIdOrThrow(id, organizationId);

    // Built-ins (BASIC/HRA/PF/ESI/PT/LWF/INCOME_TAX/etc.) are looked up by
    // exact code throughout payroll/statutory calculation regardless of
    // whether any employee currently has a per-employee override row for
    // them — the in-use check below only catches the override case, which
    // most built-ins never have, so it was never actually protecting these.
    if (existing.isSystemDefault) {
      throw new ConflictException(
        'This is a built-in salary component and cannot be deleted — deactivate it instead.',
      );
    }

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

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'SALARY_COMPONENT_DELETED',
        module: 'PAYROLL',
        organizationId,
        targetId: id,
        details: { code: existing.code, name: existing.name },
      });
    }

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

  // A FORMULA component's formula must only reference names that exist at
  // payroll time (an active component code or a system variable) and must
  // evaluate to a finite number for a representative input. Previously any
  // parseable formula was accepted: an unknown reference only surfaced as a
  // per-employee failure on the next payroll run, and a formula such as
  // "MIN()" or "IF(1 > 2, 5)" was saved and later paid out as
  // Infinity/NaN.
  private assertFormulaUsable(
    calcType: CalcType,
    formula: string | null,
    activeCodes: string[],
  ) {
    if (calcType !== CalcType.FORMULA || !formula) return;
    let referencedNames: string[];
    try {
      referencedNames = compileFormula(formula).referencedNames;
    } catch (err) {
      throw new BadRequestException(
        `Invalid formula: ${(err as Error).message}`,
      );
    }
    const known = new Set(activeCodes);
    const unknown = referencedNames.filter(
      (n) => !isKnownFormulaReference(n, known),
    );
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Formula references unknown name(s): ${unknown.join(', ')} — use an active salary component code or a system variable.`,
      );
    }
    const evaluationError = sampleEvaluationError(formula);
    if (evaluationError) {
      throw new BadRequestException(
        `Formula cannot be evaluated: ${evaluationError}`,
      );
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
