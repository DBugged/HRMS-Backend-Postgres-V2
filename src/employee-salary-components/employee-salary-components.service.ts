// Purpose: Manages an employee's individual salary-component structure as a revision history over time.
// Responsibilities: Owns applyRevision() (close-out-then-insert, never mutates an existing row's value
// fields) shared by setComponentValue and bulkSetStructure; exposes getCurrentMonthlyValue() for other
// modules (e.g. Leave Encashment) to resolve one component's live monthly value without a full payroll run.
// Important: getCurrentMonthlyValue() resolves formula/percentage dependencies recursively via
// extractDependencies/resolveComponentValue, so component definitions can reference each other by code.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  EmployeeSalaryComponent,
  Prisma,
  SalaryComponent,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { SetComponentValueDto } from './dto/set-component-value.dto';
import { BulkSetStructureDto } from './dto/bulk-set-structure.dto';
import {
  dayBefore,
  localDateStr,
  resolveCurrentRows,
  synthesizeMissingRows,
} from './salary-structure-math';
import {
  extractDependencies,
  resolveComponentValue,
} from './component-value-resolution';

@Injectable()
export class EmployeeSalaryComponentsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  async getStructure(
    employeeId: string,
    asOfParam: string | undefined,
    organizationId: string,
  ) {
    await this.assertEmployeeExists(employeeId, organizationId);
    const asOf = asOfParam ?? localDateStr();

    const [rows, activeComponents] = await Promise.all([
      this.scopedPrisma.employeeSalaryComponent.findMany({
        where: { organizationId, employeeId },
        include: { component: { select: { id: true, displayOrder: true } } },
      }),
      this.scopedPrisma.salaryComponent.findMany({
        where: { organizationId, isActive: true },
      }),
    ]);

    const current = resolveCurrentRows(rows, asOf);
    const synthesized = synthesizeMissingRows(rows, activeComponents, asOf);

    const displayOrderByCode = new Map(
      activeComponents.map((c) => [c.code, c.displayOrder]),
    );
    const structure = [...current, ...synthesized].sort(
      (a, b) =>
        (displayOrderByCode.get(a.componentCode) ?? 0) -
        (displayOrderByCode.get(b.componentCode) ?? 0),
    );

    return { structure };
  }

  async getHistory(
    employeeId: string,
    componentCode: string | undefined,
    organizationId: string,
  ) {
    await this.assertEmployeeExists(employeeId, organizationId);
    return this.scopedPrisma.employeeSalaryComponent.findMany({
      where: {
        organizationId,
        employeeId,
        ...(componentCode && { componentCode }),
      },
      include: { component: { select: { id: true, name: true, code: true } } },
      orderBy: [{ componentCode: 'asc' }, { effectiveFrom: 'desc' }],
    });
  }

  async setComponentValue(
    employeeId: string,
    dto: SetComponentValueDto,
    actorId: string,
    organizationId: string,
  ): Promise<EmployeeSalaryComponent> {
    await this.assertEmployeeExists(employeeId, organizationId);
    const component = await this.resolveComponentOrThrow(dto, organizationId);
    return this.applyRevision(
      employeeId,
      component,
      dto,
      actorId,
      organizationId,
    );
  }

  async bulkSetStructure(
    employeeId: string,
    dto: BulkSetStructureDto,
    actorId: string,
    organizationId: string,
  ) {
    await this.assertEmployeeExists(employeeId, organizationId);
    const created: EmployeeSalaryComponent[] = [];

    for (const line of dto.lines) {
      const component = await this.resolveComponent(line, organizationId);
      if (!component) continue; // matches the old system's per-line fault tolerance
      const row = await this.applyRevision(
        employeeId,
        component,
        { ...line, effectiveFrom: dto.effectiveFrom },
        actorId,
        organizationId,
      );
      created.push(row);
    }

    return { count: created.length, rows: created };
  }

  // Shared revision logic — close out the current open row (effectiveTo
  // only, never mutating value fields), then insert a brand-new row. Used
  // by both setComponentValue and bulkSetStructure so the two entry
  // points can't drift apart (the old system duplicated this inline in
  // both controllers).
  private async applyRevision(
    employeeId: string,
    component: SalaryComponent,
    dto: SetComponentValueDto,
    actorId: string,
    organizationId: string,
  ): Promise<EmployeeSalaryComponent> {
    const from = dto.effectiveFrom ?? localDateStr();

    const current = await this.scopedPrisma.employeeSalaryComponent.findFirst({
      where: {
        organizationId,
        employeeId,
        componentCode: component.code,
        effectiveTo: null,
      },
    });
    if (current) {
      await this.scopedPrisma.employeeSalaryComponent.updateMany({
        where: { id: current.id, organizationId },
        data: { effectiveTo: dayBefore(from) },
      });
    }

    return this.scopedPrisma.employeeSalaryComponent.create({
      data: {
        organizationId,
        employeeId,
        componentId: component.id,
        componentCode: component.code,
        valueType: dto.valueType ?? component.calcType,
        fixedAmount: dto.fixedAmount ?? null,
        percentageValue: dto.percentageValue ?? null,
        percentageOf: dto.percentageOf ?? null,
        formula: dto.formula ?? null,
        amountBasis: dto.amountBasis ?? 'MONTHLY',
        isEnabled: dto.isEnabled ?? true,
        effectiveFrom: from,
        effectiveTo: null,
        revisionNote: dto.revisionNote ?? '',
        createdById: actorId,
      },
    });
  }

  // Resolves an employee's current monthly value for a single component
  // code (e.g. 'BASIC'), reading from their live structure rather than a
  // full payroll run — ported from the old backend's
  // getCurrentComponentMonthlyValue, used by Leave Encashment's rate
  // calculation and reused verbatim by Payroll core later.
  async getCurrentMonthlyValue(
    employeeId: string,
    code: string,
    asOf: string,
    organizationId: string,
  ): Promise<number> {
    const component = await this.scopedPrisma.salaryComponent.findFirst({
      where: { organizationId, code },
    });
    if (!component) return 0;

    const rows = await this.scopedPrisma.employeeSalaryComponent.findMany({
      where: { organizationId, employeeId },
    });
    const current = resolveCurrentRows(rows, asOf);
    const overridesByCode = new Map(current.map((r) => [r.componentCode, r]));
    const override = overridesByCode.get(code) ?? null;

    if (override && override.isEnabled === false) return 0;

    const context: Record<string, number> = {};
    for (const dep of extractDependencies(component, override)) {
      if (context[dep] !== undefined) continue;
      const depComponent = await this.scopedPrisma.salaryComponent.findFirst({
        where: { organizationId, code: dep },
      });
      if (!depComponent) continue;
      context[dep] = resolveComponentValue(
        depComponent,
        overridesByCode.get(dep) ?? null,
        {},
      );
    }

    return resolveComponentValue(component, override, context);
  }

  private async resolveComponentOrThrow(
    dto: { componentId?: string; componentCode?: string },
    organizationId: string,
  ): Promise<SalaryComponent> {
    const component = await this.resolveComponent(dto, organizationId);
    if (!component) throw new NotFoundException('Salary component not found.');
    return component;
  }

  private resolveComponent(
    dto: { componentId?: string; componentCode?: string },
    organizationId: string,
  ): Promise<SalaryComponent | null> {
    if (!dto.componentId && !dto.componentCode) return Promise.resolve(null);
    const where: Prisma.SalaryComponentWhereInput = dto.componentId
      ? { id: dto.componentId, organizationId }
      : { code: dto.componentCode, organizationId };
    return this.scopedPrisma.salaryComponent.findFirst({ where });
  }

  private async assertEmployeeExists(
    employeeId: string,
    organizationId: string,
  ) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
  }
}
