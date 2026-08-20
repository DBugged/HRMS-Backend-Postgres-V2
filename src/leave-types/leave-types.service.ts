import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LeaveType, Prisma } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { LeaveBalanceService } from '../leave-balances/leave-balance.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CreateLeaveTypeDto } from './dto/create-leave-type.dto';
import { UpdateLeaveTypeDto } from './dto/update-leave-type.dto';
import { RunCarryForwardDto } from './dto/run-carry-forward.dto';
import { wrapAll } from '../common/pagination';
import { LEAVE_TYPE_DEFAULTS } from './leave-type-defaults';

@Injectable()
export class LeaveTypesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // Every new org starts with the standard leave-type set (Casual, Sick,
  // Earned, Maternity, etc.) instead of an empty Leave Types page — admin
  // can edit/disable/add to these from Leave Types afterward. Same
  // registration-time integration point as StatutoryConfigService.seedDefaults.
  async seedDefaults(
    tx: Prisma.TransactionClient,
    organizationId: string,
    createdById?: string,
  ): Promise<void> {
    for (const def of LEAVE_TYPE_DEFAULTS) {
      const { carryForward, encashment, rules, ...rest } = def;
      await tx.leaveType.create({
        data: {
          ...rest,
          organizationId,
          createdById,
          rules: rules as unknown as Prisma.InputJsonValue,
          ...(carryForward !== undefined && {
            carryForward: carryForward,
          }),
          ...(encashment !== undefined && {
            encashment: encashment,
          }),
        },
      });
    }
  }

  async create(
    dto: CreateLeaveTypeDto,
    organizationId: string,
    createdById: string,
  ) {
    await this.assertNoDuplicate(organizationId, dto.name, dto.code);

    return this.scopedPrisma.leaveType.create({
      data: {
        organizationId,
        name: dto.name,
        code: dto.code,
        description: dto.description ?? '',
        color: dto.color ?? '#3b82f6',
        isPaid: dto.isPaid ?? true,
        displayOrder: dto.displayOrder ?? 0,
        allocationType: dto.allocationType,
        annualQuota: dto.annualQuota ?? 0,
        accrualFrequency: dto.accrualFrequency,
        accrualAmountPerCycle: dto.accrualAmountPerCycle ?? 0,
        prorateOnJoining: dto.prorateOnJoining ?? true,
        applicableDepartments: dto.applicableDepartments ?? [],
        applicableEmployeeTypes: dto.applicableEmployeeTypes ?? [],
        applicableGenders: dto.applicableGenders ?? [],
        minServiceMonths: dto.minServiceMonths ?? 0,
        maxServiceMonths: dto.maxServiceMonths,
        salaryImpactPercent: dto.salaryImpactPercent ?? 100,
        affectsLopCalculation: dto.affectsLopCalculation ?? true,
        requiresApproval: dto.requiresApproval ?? true,
        approvalLevels: dto.approvalLevels ?? 2,
        autoApproveIfNoAction: dto.autoApproveIfNoAction ?? false,
        autoApproveDays: dto.autoApproveDays ?? 0,
        ...(dto.rules !== undefined && {
          rules: dto.rules as unknown as Prisma.InputJsonValue,
        }),
        documentsRequired: dto.documentsRequired ?? false,
        documentRequiredAfterDays: dto.documentRequiredAfterDays,
        ...(dto.carryForward !== undefined && {
          carryForward: dto.carryForward as unknown as Prisma.InputJsonValue,
        }),
        ...(dto.negativeBalance !== undefined && {
          negativeBalance:
            dto.negativeBalance as unknown as Prisma.InputJsonValue,
        }),
        ...(dto.encashment !== undefined && {
          encashment: dto.encashment as unknown as Prisma.InputJsonValue,
        }),
        createdById,
      },
    });
  }

  async findAll(organizationId: string, activeOnly?: boolean) {
    const data = await this.scopedPrisma.leaveType.findMany({
      where: { organizationId, ...(activeOnly && { isActive: true }) },
      orderBy: { displayOrder: 'asc' },
    });
    return wrapAll(data);
  }

  async findOne(id: string, organizationId: string) {
    return this.findByIdOrThrow(id, organizationId);
  }

  async update(id: string, dto: UpdateLeaveTypeDto, organizationId: string) {
    const existing = await this.findByIdOrThrow(id, organizationId);
    await this.assertNoDuplicate(
      organizationId,
      dto.name ?? existing.name,
      dto.code ?? existing.code,
      id,
    );

    await this.scopedPrisma.leaveType.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.code !== undefined && { code: dto.code }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.isPaid !== undefined && { isPaid: dto.isPaid }),
        ...(dto.displayOrder !== undefined && {
          displayOrder: dto.displayOrder,
        }),
        ...(dto.allocationType !== undefined && {
          allocationType: dto.allocationType,
        }),
        ...(dto.annualQuota !== undefined && { annualQuota: dto.annualQuota }),
        ...(dto.accrualFrequency !== undefined && {
          accrualFrequency: dto.accrualFrequency,
        }),
        ...(dto.accrualAmountPerCycle !== undefined && {
          accrualAmountPerCycle: dto.accrualAmountPerCycle,
        }),
        ...(dto.prorateOnJoining !== undefined && {
          prorateOnJoining: dto.prorateOnJoining,
        }),
        ...(dto.applicableDepartments !== undefined && {
          applicableDepartments: dto.applicableDepartments,
        }),
        ...(dto.applicableEmployeeTypes !== undefined && {
          applicableEmployeeTypes: dto.applicableEmployeeTypes,
        }),
        ...(dto.applicableGenders !== undefined && {
          applicableGenders: dto.applicableGenders,
        }),
        ...(dto.minServiceMonths !== undefined && {
          minServiceMonths: dto.minServiceMonths,
        }),
        ...(dto.maxServiceMonths !== undefined && {
          maxServiceMonths: dto.maxServiceMonths,
        }),
        ...(dto.salaryImpactPercent !== undefined && {
          salaryImpactPercent: dto.salaryImpactPercent,
        }),
        ...(dto.affectsLopCalculation !== undefined && {
          affectsLopCalculation: dto.affectsLopCalculation,
        }),
        ...(dto.requiresApproval !== undefined && {
          requiresApproval: dto.requiresApproval,
        }),
        ...(dto.approvalLevels !== undefined && {
          approvalLevels: dto.approvalLevels,
        }),
        ...(dto.autoApproveIfNoAction !== undefined && {
          autoApproveIfNoAction: dto.autoApproveIfNoAction,
        }),
        ...(dto.autoApproveDays !== undefined && {
          autoApproveDays: dto.autoApproveDays,
        }),
        ...(dto.rules !== undefined && {
          rules: dto.rules as unknown as Prisma.InputJsonValue,
        }),
        ...(dto.documentsRequired !== undefined && {
          documentsRequired: dto.documentsRequired,
        }),
        ...(dto.documentRequiredAfterDays !== undefined && {
          documentRequiredAfterDays: dto.documentRequiredAfterDays,
        }),
        ...(dto.carryForward !== undefined && {
          carryForward: dto.carryForward as unknown as Prisma.InputJsonValue,
        }),
        ...(dto.negativeBalance !== undefined && {
          negativeBalance:
            dto.negativeBalance as unknown as Prisma.InputJsonValue,
        }),
        ...(dto.encashment !== undefined && {
          encashment: dto.encashment as unknown as Prisma.InputJsonValue,
        }),
      },
    });

    return this.findByIdOrThrow(id, organizationId);
  }

  async remove(id: string, organizationId: string) {
    await this.findByIdOrThrow(id, organizationId);
    await this.scopedPrisma.leaveType.deleteMany({
      where: { id, organizationId },
    });
    return { message: 'Leave type deleted' };
  }

  getEligibleForMe(employeeId: string, organizationId: string) {
    return this.leaveBalanceService.getEligibleLeaveTypes(
      employeeId,
      organizationId,
    );
  }

  async runAccrual(id: string, actorId: string, organizationId: string) {
    const leaveType = await this.findByIdOrThrow(id, organizationId);
    const { matched } = await this.leaveBalanceService.creditAccrual(
      id,
      organizationId,
    );
    await this.auditLogService.log({
      actorId,
      action: 'LEAVE_ACCRUAL_RUN',
      module: 'LEAVE',
      organizationId,
      targetId: id,
      details: {
        leaveType: leaveType.code,
        amount: leaveType.accrualAmountPerCycle,
        matched,
      },
    });
    return { message: `Accrual credited to ${matched} employee(s)`, matched };
  }

  async runCarryForward(
    dto: RunCarryForwardDto,
    actorId: string,
    organizationId: string,
  ) {
    const year = dto.year ?? new Date().getFullYear();
    const { processed } = await this.leaveBalanceService.runYearEndCarryForward(
      year,
      organizationId,
    );
    await this.auditLogService.log({
      actorId,
      action: 'LEAVE_CARRYFORWARD_RUN',
      module: 'LEAVE',
      organizationId,
      details: { year, processed },
    });
    return {
      message: `Carried forward balances for ${processed} employee/leave-type combination(s)`,
      processed,
      year,
    };
  }

  private async assertNoDuplicate(
    organizationId: string,
    name: string,
    code: string,
    excludeId?: string,
  ) {
    const duplicate = await this.scopedPrisma.leaveType.findFirst({
      where: {
        organizationId,
        OR: [{ name }, { code }],
        ...(excludeId && { id: { not: excludeId } }),
      },
    });
    if (duplicate) {
      throw new ConflictException(
        'A leave type with this name or code already exists.',
      );
    }
  }

  private async findByIdOrThrow(
    id: string,
    organizationId: string,
  ): Promise<LeaveType> {
    const leaveType = await this.scopedPrisma.leaveType.findFirst({
      where: { id, organizationId },
    });
    if (!leaveType) throw new NotFoundException('Leave type not found.');
    return leaveType;
  }
}
