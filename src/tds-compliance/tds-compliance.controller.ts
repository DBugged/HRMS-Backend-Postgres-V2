// Purpose: HTTP surface for salary TDS compliance — monthly statement, quarterly return data, annual salary
//   details, challan and statement-receipt records, and the Form 130 certificate.
// Important: Everything is ADMIN/HR except Form 130, which an employee can download for themselves once the year's
//   last statement is on record. Report exports are audited and throttled like the other payroll reports.
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
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
import { Roles } from '../common/decorators/roles.decorator';
import { SelfOrRoles } from '../common/decorators/self-or-roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { sendReportBranded } from '../reports/report-branding';
import { TdsComplianceService } from './tds-compliance.service';
import { renderForm130 } from './form130-pdf';
import { loadReportLogo } from '../reports/report-branding';
import {
  ChallanListQueryDto,
  CreateChallanDto,
  Form130QueryDto,
  SetStatementDto,
  TdsMonthQueryDto,
  TdsQuarterQueryDto,
  TdsYearQueryDto,
  UpdateChallanDto,
} from './dto/tds.dto';

type Caller = Omit<User, 'password'>;

@ApiTags('tds')
@ApiBearerAuth('access-token')
@Controller('tds')
export class TdsComplianceController {
  constructor(
    private readonly service: TdsComplianceService,
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  @Get('monthly')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  monthly(@Query() q: TdsMonthQueryDto, @CurrentUser() c: Caller) {
    return this.service.monthlySummary(q.month, q.year, c.organizationId);
  }

  @Get('monthly/report')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @UseInterceptors(ExportAuditInterceptor)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async monthlyReport(
    @Query() q: TdsMonthQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    const report = await this.service.monthlyReport(
      q.month,
      q.year,
      c.organizationId,
    );
    await sendReportBranded(res, this.scopedPrisma, c.organizationId, {
      ...report,
      format: q.format ?? 'xlsx',
    });
  }

  @Get('quarterly')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  quarterly(@Query() q: TdsQuarterQueryDto, @CurrentUser() c: Caller) {
    return this.service.quarterlySummary(
      q.financialYear,
      q.quarter,
      c.organizationId,
    );
  }

  @Get('quarterly/report')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @UseInterceptors(ExportAuditInterceptor)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async quarterlyReport(
    @Query() q: TdsQuarterQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    const report = await this.service.quarterlyReport(
      q.financialYear,
      q.quarter,
      c.organizationId,
    );
    await sendReportBranded(res, this.scopedPrisma, c.organizationId, {
      ...report,
      format: q.format ?? 'xlsx',
    });
  }

  @Get('annexure-ii/report')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @UseInterceptors(ExportAuditInterceptor)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async annexureII(
    @Query() q: TdsYearQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    const report = await this.service.annexureIIReport(
      q.financialYear,
      c.organizationId,
    );
    await sendReportBranded(res, this.scopedPrisma, c.organizationId, {
      ...report,
      format: q.format ?? 'xlsx',
    });
  }

  @Get('challans')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  challans(@Query() q: ChallanListQueryDto, @CurrentUser() c: Caller) {
    return this.service.listChallans(q.financialYear, c.organizationId);
  }

  @Post('challans')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  createChallan(@Body() dto: CreateChallanDto, @CurrentUser() c: Caller) {
    return this.service.createChallan(dto, c, c.organizationId);
  }

  @Patch('challans/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateChallan(
    @Param('id') id: string,
    @Body() dto: UpdateChallanDto,
    @CurrentUser() c: Caller,
  ) {
    return this.service.updateChallan(id, dto, c, c.organizationId);
  }

  @Delete('challans/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  removeChallan(@Param('id') id: string, @CurrentUser() c: Caller) {
    return this.service.removeChallan(id, c, c.organizationId);
  }

  @Get('statements')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  statements(@Query() q: ChallanListQueryDto, @CurrentUser() c: Caller) {
    return this.service.listStatements(q.financialYear, c.organizationId);
  }

  @Put('statements')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  setStatement(@Body() dto: SetStatementDto, @CurrentUser() c: Caller) {
    return this.service.setStatement(dto, c, c.organizationId);
  }

  @Get('form130/:id')
  @SelfOrRoles('id', Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @UseInterceptors(ExportAuditInterceptor)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async form130(
    @Param('id') id: string,
    @Query() q: Form130QueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    const data = await this.service.form130Data(
      id,
      q.financialYear,
      c,
      c.organizationId,
    );
    const logo = await loadReportLogo(this.scopedPrisma, c.organizationId);
    const pdf = await renderForm130(data, logo);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${data.formName.replace(' ', '')}_${data.employee.code}_${q.financialYear}.pdf"`,
      'Content-Length': String(pdf.length),
    });
    res.end(pdf);
  }
}
