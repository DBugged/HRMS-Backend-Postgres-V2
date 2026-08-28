// Purpose: Employee expense-reimbursement claim submission and manager/HR review.
// Responsibilities: Owns receipt-URL signing (withSignedReceipt, same relativeKey pattern as
// DocumentsService.withSignedUrl) on every read, and department-scoped review authorization via
// assertManagerDeptScope.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationCategory,
  Prisma,
  Reimbursement,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { signFileToken } from '../files/file-token';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { CreateReimbursementDto } from './dto/create-reimbursement.dto';
import { ReviewReimbursementDto } from './dto/review-reimbursement.dto';
import { QueryReimbursementDto } from './dto/query-reimbursement.dto';
import { paginate, skip } from '../common/pagination';
import {
  assertManagerDeptScope,
  deptScopedEmployeeIds,
} from '../common/dept-scope';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';

type Actor = Omit<User, 'password'>;

const EXTERNAL_URL_RE = /^https?:\/\//i;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

@Injectable()
export class ReimbursementsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
  ) {}

  // receiptUrl is stored as the relativeKey from POST /files/upload/documents
  // — never servable as-is, so every read signs it fresh, same pattern as
  // DocumentsService.withSignedUrl.
  private withSignedReceipt<T extends Reimbursement>(claim: T): T {
    if (!claim.receiptUrl || EXTERNAL_URL_RE.test(claim.receiptUrl)) {
      return claim;
    }
    return {
      ...claim,
      receiptUrl: `/files/${signFileToken(claim.organizationId, claim.receiptUrl)}`,
    };
  }

  async findAll(
    query: QueryReimbursementDto,
    actor: Actor,
    organizationId: string,
  ) {
    const where: Prisma.ReimbursementWhereInput = { organizationId };

    if (actor.role === Role.EMPLOYEE) {
      where.employeeId = actor.id;
    } else if (actor.role === Role.MANAGER) {
      where.employeeId = {
        in: await deptScopedEmployeeIds(
          this.scopedPrisma,
          actor,
          organizationId,
        ),
      };
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.status) where.status = query.status;

    const result = await paginate(
      () =>
        this.scopedPrisma.reimbursement.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.reimbursement.count({ where }),
      query.page,
      query.limit,
    );
    return {
      ...result,
      data: result.data.map((c) => this.withSignedReceipt(c)),
    };
  }

  async create(
    dto: CreateReimbursementDto,
    actor: Actor,
    organizationId: string,
  ) {
    const claim = await this.scopedPrisma.reimbursement.create({
      data: {
        organizationId,
        employeeId: actor.id,
        category: dto.category,
        amount: dto.amount,
        claimDate: dto.claimDate,
        description: dto.description ?? '',
        receiptUrl: dto.receiptUrl ?? '',
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'REIMBURSEMENT_SUBMITTED',
      module: 'PAYROLL',
      organizationId,
      targetId: claim.id,
      details: {
        employeeId: actor.id,
        category: dto.category,
        amount: dto.amount,
      },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: actor.id,
      eventKey: 'REIMBURSEMENT_SUBMITTED',
      performedById: actor.id,
      description: `Submitted a reimbursement claim of ${dto.amount} for ${dto.category}.`,
    });

    return this.withSignedReceipt(claim);
  }

  async review(
    id: string,
    dto: ReviewReimbursementDto,
    actor: Actor,
    organizationId: string,
  ) {
    const claim = await this.scopedPrisma.reimbursement.findFirst({
      where: { id, organizationId },
    });
    if (!claim) throw new NotFoundException('Reimbursement claim not found.');
    await assertManagerDeptScope(
      this.scopedPrisma,
      actor,
      organizationId,
      claim.employeeId,
    );

    // PAID is a separate step from the initial Approve/Reject decision — a
    // claim must already be APPROVED before it can be marked PAID (mirrors
    // Leave Encashment's PENDING -> APPROVED -> PROCESSED chain, which has
    // the same single-direction-forward-only shape).
    if (dto.status === 'PAID' && claim.status !== 'APPROVED') {
      throw new BadRequestException(
        'Only an approved claim can be marked as paid.',
      );
    }

    await this.scopedPrisma.reimbursement.updateMany({
      where: { id, organizationId },
      data:
        dto.status === 'PAID'
          ? {
              status: dto.status,
              reviewComments: dto.reviewComments ?? claim.reviewComments,
              paidDate: todayStr(),
              paidById: actor.id,
            }
          : {
              status: dto.status,
              reviewComments: dto.reviewComments ?? '',
              approvedById: actor.id,
            },
    });
    const updated = await this.scopedPrisma.reimbursement.findFirstOrThrow({
      where: { id, organizationId },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'REIMBURSEMENT_REVIEWED',
      module: 'PAYROLL',
      organizationId,
      targetId: id,
      details: { employeeId: claim.employeeId, status: dto.status },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: claim.employeeId,
      eventKey: 'REIMBURSEMENT_REVIEWED',
      performedById: actor.id,
      description: `Reimbursement claim ${dto.status.toLowerCase()}.`,
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: claim.employeeId, organizationId },
    });
    if (employee) {
      const title = `Reimbursement Claim ${dto.status}`;
      const message = `Your reimbursement claim of ${claim.amount} for ${claim.category} has been ${dto.status.toLowerCase()}.${dto.reviewComments ? ` Comments: ${dto.reviewComments}` : ''}`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.GENERAL,
      });
      await this.emailService.send({
        to: employee.email,
        subject: title,
        html: message,
      });
    }

    return this.withSignedReceipt(updated);
  }
}
