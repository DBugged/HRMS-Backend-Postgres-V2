import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OffboardingStatus, Prisma, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { InitiateOffboardingDto } from './dto/initiate-offboarding.dto';
import { UpdateChecklistDto } from './dto/update-checklist.dto';
import { SubmitExitInterviewDto } from './dto/submit-exit-interview.dto';
import { LinkSettlementDto } from './dto/link-settlement.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';

type Actor = Omit<User, 'password'>;

const OPEN_STATUSES: OffboardingStatus[] = [
  OffboardingStatus.INITIATED,
  OffboardingStatus.IN_PROGRESS,
];
const CLOSED_STATUSES: OffboardingStatus[] = [
  OffboardingStatus.COMPLETED,
  OffboardingStatus.CANCELLED,
];

@Injectable()
export class OffboardingService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
  ) {}

  async findAll(organizationId: string) {
    return this.scopedPrisma.offboardingCase.findMany({
      where: { organizationId },
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
        settlement: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, organizationId: string) {
    const record = await this.scopedPrisma.offboardingCase.findFirst({
      where: { id, organizationId },
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
        settlement: true,
      },
    });
    if (!record) throw new NotFoundException('Offboarding case not found.');
    return record;
  }

  async initiate(
    dto: InitiateOffboardingDto,
    actor: Actor,
    organizationId: string,
  ) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: dto.employeeId, organizationId },
    });
    if (!employee) throw new NotFoundException('Employee not found.');

    const existing = await this.scopedPrisma.offboardingCase.findFirst({
      where: {
        employeeId: dto.employeeId,
        organizationId,
        status: { in: OPEN_STATUSES },
      },
    });
    if (existing) {
      throw new BadRequestException(
        'An offboarding case is already in progress for this employee.',
      );
    }

    return this.scopedPrisma.offboardingCase.create({
      data: {
        organizationId,
        employeeId: dto.employeeId,
        initiatedById: actor.id,
        lastWorkingDay: dto.lastWorkingDay,
        reason: dto.reason,
      },
    });
  }

  async updateChecklist(
    id: string,
    dto: UpdateChecklistDto,
    organizationId: string,
  ) {
    const record = await this.assertOpenCase(id, organizationId);

    const data: Prisma.OffboardingCaseUpdateManyMutationInput = {};
    if (dto.assetsReturned !== undefined)
      data.assetsReturned = dto.assetsReturned;
    if (dto.accessRevoked !== undefined) data.accessRevoked = dto.accessRevoked;
    if (record.status === OffboardingStatus.INITIATED) {
      data.status = OffboardingStatus.IN_PROGRESS;
    }

    await this.scopedPrisma.offboardingCase.updateMany({
      where: { id, organizationId },
      data,
    });
    return this.findOne(id, organizationId);
  }

  // Basic exit-interview questionnaire — captured once per case, then
  // effectively locked (re-submitting overwrites, same as any other
  // checklist correction — there's no separate "edit" endpoint since HR can
  // just call this again).
  async submitExitInterview(
    id: string,
    dto: SubmitExitInterviewDto,
    organizationId: string,
  ) {
    const record = await this.assertOpenCase(id, organizationId);

    const data: Prisma.OffboardingCaseUpdateManyMutationInput = {
      exitInterviewResponses: {
        reasonForLeaving: dto.reasonForLeaving,
        overallExperience: dto.overallExperience,
        wouldRecommend: !!dto.wouldRecommend,
        likedMost: dto.likedMost ?? '',
        improvementAreas: dto.improvementAreas ?? '',
        additionalComments: dto.additionalComments ?? '',
      } satisfies Prisma.InputJsonValue,
      exitInterviewDone: true,
    };
    if (record.status === OffboardingStatus.INITIATED) {
      data.status = OffboardingStatus.IN_PROGRESS;
    }

    await this.scopedPrisma.offboardingCase.updateMany({
      where: { id, organizationId },
      data,
    });
    return this.findOne(id, organizationId);
  }

  async linkSettlement(
    id: string,
    dto: LinkSettlementDto,
    organizationId: string,
  ) {
    const record = await this.findOne(id, organizationId);
    const settlement = await this.scopedPrisma.settlement.findFirst({
      where: { id: dto.settlementId, organizationId },
    });
    if (!settlement || settlement.employeeId !== record.employeeId) {
      throw new BadRequestException('Settlement not found for this employee.');
    }

    await this.scopedPrisma.offboardingCase.updateMany({
      where: { id, organizationId },
      data: { settlementId: dto.settlementId },
    });
    return this.findOne(id, organizationId);
  }

  // Requires the full checklist done and a settlement linked before an exit
  // can be finalized — mirrors the "no critical issues remain" gate used
  // elsewhere for other certification-style sign-offs. Completing it
  // deactivates the account.
  async complete(id: string, actor: Actor, organizationId: string) {
    const record = await this.assertOpenCase(id, organizationId);

    const missing: string[] = [];
    if (!record.assetsReturned) missing.push('assetsReturned');
    if (!record.accessRevoked) missing.push('accessRevoked');
    if (!record.exitInterviewDone) missing.push('exitInterviewDone');
    if (!record.settlementId) missing.push('settlement');
    if (missing.length > 0) {
      throw new BadRequestException(
        `Cannot complete offboarding — outstanding: ${missing.join(', ')}`,
      );
    }

    await this.scopedPrisma.$transaction(async (tx) => {
      await tx.offboardingCase.updateMany({
        where: { id, organizationId },
        data: {
          status: OffboardingStatus.COMPLETED,
          completedById: actor.id,
          completedAt: new Date(),
        },
      });
      await tx.user.updateMany({
        where: { id: record.employeeId, organizationId },
        data: { isActive: false },
      });
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_DEACTIVATED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: record.employeeId,
      details: { reason: 'offboarding_completed' },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: record.employeeId,
      eventKey: 'RELIEVED',
      performedById: actor.id,
      status: 'inactive',
    });
    return this.findOne(id, organizationId);
  }

  async cancel(id: string, organizationId: string) {
    const record = await this.findOne(id, organizationId);
    if (record.status === OffboardingStatus.COMPLETED) {
      throw new BadRequestException(
        'A completed offboarding case cannot be cancelled.',
      );
    }

    await this.scopedPrisma.offboardingCase.updateMany({
      where: { id, organizationId },
      data: { status: OffboardingStatus.CANCELLED },
    });
    return this.findOne(id, organizationId);
  }

  private async assertOpenCase(id: string, organizationId: string) {
    const record = await this.findOne(id, organizationId);
    if (CLOSED_STATUSES.includes(record.status)) {
      throw new BadRequestException('This offboarding case is already closed.');
    }
    return record;
  }
}
