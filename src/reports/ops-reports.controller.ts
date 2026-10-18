// Purpose: Exposes the operational reports (overtime, regularization, loans, reimbursements, tax declaration status,
//   payroll variance) as file exports.
// Responsibilities: validates the query and hands it to OpsReportsService; overtime and regularization allow a Manager
//   (own department only), the rest are Admin/HR.
import {
  Controller,
  Get,
  Inject,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import { ExportAuditInterceptor } from '../common/sensitive-audit';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { sendReportBranded } from './report-branding';
import { OpsReportsService } from './ops-reports.service';
import type { ReportPayload } from './reports.service';
import { OpsReportQueryDto } from './dto/ops-report-queries.dto';

type Caller = Omit<User, 'password'>;

@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports')
@Roles(Role.ADMIN, Role.HR, Role.MANAGER)
@UseGuards(RolesGuard)
@UseInterceptors(ExportAuditInterceptor)
@Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
export class OpsReportsController {
  constructor(
    private readonly ops: OpsReportsService,
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  private send(
    res: Response,
    caller: Caller,
    query: OpsReportQueryDto,
    report: ReportPayload,
  ) {
    return sendReportBranded(res, this.scopedPrisma, caller.organizationId, {
      ...report,
      format: query.format ?? 'xlsx',
    });
  }

  @Get('overtime')
  async overtime(
    @Query() q: OpsReportQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    return this.send(
      res,
      c,
      q,
      await this.ops.overtimeReport(q, c, c.organizationId),
    );
  }

  @Get('regularization')
  async regularization(
    @Query() q: OpsReportQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    return this.send(
      res,
      c,
      q,
      await this.ops.regularizationReport(q, c, c.organizationId),
    );
  }

  @Get('loans')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async loans(
    @Query() q: OpsReportQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    return this.send(
      res,
      c,
      q,
      await this.ops.loanRegisterReport(q, c, c.organizationId),
    );
  }

  @Get('reimbursements')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async reimbursements(
    @Query() q: OpsReportQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    return this.send(
      res,
      c,
      q,
      await this.ops.reimbursementReport(q, c, c.organizationId),
    );
  }

  @Get('tax-declaration-status')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async taxDeclarationStatus(
    @Query() q: OpsReportQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    return this.send(
      res,
      c,
      q,
      await this.ops.taxDeclarationStatusReport(q, c, c.organizationId),
    );
  }

  @Get('payroll-variance')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async payrollVariance(
    @Query() q: OpsReportQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    return this.send(
      res,
      c,
      q,
      await this.ops.payrollVarianceReport(q, c, c.organizationId),
    );
  }
}
