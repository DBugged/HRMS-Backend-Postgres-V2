import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  EmployeeTaxDeclaration,
  NotificationCategory,
  Role,
  TaxDeclarationStatus,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { UpsertTaxDeclarationDto } from './dto/upsert-tax-declaration.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';

type Actor = Omit<User, 'password'>;

@Injectable()
export class TaxDeclarationsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  async get(
    employeeIdParam: string | undefined,
    financialYear: string | undefined,
    actor: Actor,
    organizationId: string,
  ) {
    const employeeId =
      actor.role === Role.EMPLOYEE ? actor.id : employeeIdParam;
    if (!employeeId || !financialYear) {
      throw new BadRequestException(
        'employeeId and financialYear are required.',
      );
    }

    const declaration =
      await this.scopedPrisma.employeeTaxDeclaration.findFirst({
        where: { organizationId, employeeId, financialYear },
      });
    return { declaration };
  }

  async upsert(
    dto: UpsertTaxDeclarationDto,
    actor: Actor,
    organizationId: string,
  ) {
    const employeeId = actor.role === Role.EMPLOYEE ? actor.id : dto.employeeId;
    if (!employeeId) {
      throw new BadRequestException('employeeId is required.');
    }

    // Identity-based, not role-based — closes the gap where an HR/Admin
    // editing their OWN record could self-verify. Any caller editing
    // someone else's declaration may set status; editing your own never
    // can, regardless of your role.
    const isOwnDeclaration = employeeId === actor.id;
    const status = isOwnDeclaration ? undefined : dto.status;

    const data = {
      ...(dto.regimeChosen !== undefined && { regimeChosen: dto.regimeChosen }),
      ...(dto.section80C !== undefined && { section80C: dto.section80C }),
      ...(dto.section80CCD1B !== undefined && {
        section80CCD1B: dto.section80CCD1B,
      }),
      ...(dto.section80CCD2 !== undefined && {
        section80CCD2: dto.section80CCD2,
      }),
      ...(dto.section80D !== undefined && { section80D: dto.section80D }),
      ...(dto.section80E !== undefined && { section80E: dto.section80E }),
      ...(dto.section80G !== undefined && { section80G: dto.section80G }),
      ...(dto.otherDeductions !== undefined && {
        otherDeductions: dto.otherDeductions,
      }),
      ...(dto.hraRentPaidAnnual !== undefined && {
        hraRentPaidAnnual: dto.hraRentPaidAnnual,
      }),
      ...(dto.isMetroCity !== undefined && { isMetroCity: dto.isMetroCity }),
      ...(dto.ltaClaimed !== undefined && { ltaClaimed: dto.ltaClaimed }),
      ...(dto.previousEmployerIncome !== undefined && {
        previousEmployerIncome: dto.previousEmployerIncome,
      }),
      ...(dto.previousEmployerTDS !== undefined && {
        previousEmployerTDS: dto.previousEmployerTDS,
      }),
      ...(dto.otherIncome !== undefined && { otherIncome: dto.otherIncome }),
      ...(status !== undefined && { status }),
    };

    const existing = await this.scopedPrisma.employeeTaxDeclaration.findFirst({
      where: { organizationId, employeeId, financialYear: dto.financialYear },
    });

    let declaration: EmployeeTaxDeclaration;
    if (existing) {
      await this.scopedPrisma.employeeTaxDeclaration.updateMany({
        where: { id: existing.id, organizationId },
        data,
      });
      declaration =
        await this.scopedPrisma.employeeTaxDeclaration.findFirstOrThrow({
          where: { id: existing.id, organizationId },
        });
    } else {
      declaration = await this.scopedPrisma.employeeTaxDeclaration.create({
        data: {
          organizationId,
          employeeId,
          financialYear: dto.financialYear,
          ...data,
        },
      });
    }

    if (!isOwnDeclaration && status === TaxDeclarationStatus.VERIFIED) {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId },
      });
      if (employee) {
        const title = 'Tax Declaration Verified';
        const message = `Your tax declaration for FY ${dto.financialYear} has been verified.`;
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
    }

    return declaration;
  }
}
