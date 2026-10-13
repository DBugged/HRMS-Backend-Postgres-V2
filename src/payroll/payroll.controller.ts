// Purpose: Exposes the payroll run lifecycle — draft, calculate, adjust, verify/approve/lock/pay/unlock — plus payslip PDF download.
// Responsibilities: Validates DTOs, streams payslip PDFs via raw @Res(), and delegates all logic to PayrollService/PayslipPdfService.
// Important: Reads self/dept-scope inline in the service (EMPLOYEE/MANAGER own-only); every write is ADMIN/HR.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PayrollRunStatus, Role, User } from '@prisma/client';
import { PayrollService } from './payroll.service';
import { PayslipPdfService } from './payslip-pdf.service';
import { PrivacyAuditService } from '../privacy/privacy-audit.service';
import { auditSensitive } from '../common/sensitive-audit';
import { DraftPayrollDto } from './dto/draft-payroll.dto';
import { AttendanceGapsQueryDto } from './dto/attendance-gaps-query.dto';
import { StructurePreviewDto } from './dto/structure-preview.dto';
import { CalculatePayrollDto } from './dto/calculate-payroll.dto';
import { QueryPayrollDto } from './dto/query-payroll.dto';
import { AdjustPayrollDto } from './dto/adjust-payroll.dto';
import { BulkTransitionPayrollDto } from './dto/bulk-transition-payroll.dto';
import { UnlockPayrollDto } from './dto/unlock-payroll.dto';
import { CreateSupplementaryPayrollDto } from './dto/create-supplementary-payroll.dto';
import { ArrearsPreviewDto, CreateArrearsDto } from './dto/arrears.dto';
import { ImportPaymentsDto, RecordPaymentDto } from './dto/payment.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';

type Caller = Omit<User, 'password'>;

const FINALIZED_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.LOCKED,
  PayrollRunStatus.PAID,
];

@ApiTags('payroll')
@ApiBearerAuth('access-token')
@Controller('payroll')
export class PayrollController {
  constructor(
    private readonly payrollService: PayrollService,
    private readonly payslipPdfService: PayslipPdfService,
    private readonly privacyAudit: PrivacyAuditService,
  ) {}

  // No @Roles() — any authenticated caller, self/dept-scoped inline in
  // the service (EMPLOYEE and MANAGER forced to their own payslips; HR/ADMIN org-wide).
  @Get()
  findAll(@Query() query: QueryPayrollDto, @CurrentUser() caller: Caller) {
    return this.payrollService.findAll(query, caller, caller.organizationId);
  }

  // Registered before ':id' so Nest doesn't try to match "history" as a
  // route param — same reason as Holidays' bulk-import and LeaveTypes'
  // eligible/me routes.
  @Get('history')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  history(@Query() query: QueryPayrollDto, @CurrentUser() caller: Caller) {
    return this.payrollService.getHistory(query, caller, caller.organizationId);
  }

  // Registered before ':id' for the same reason as 'history' above.
  @Get('attendance-gaps')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  attendanceGaps(
    @Query() query: AttendanceGapsQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.getAttendanceGaps(
      query.month,
      query.year,
      caller.organizationId,
    );
  }

  // The months whose payslip exists but is not final yet (calculated / verified / approved) - month and year only, no
  // amounts - so the app can say "being finalised" instead of leaving the employee guessing. Own months only; any
  // authenticated caller. Registered before ':id' so it is not read as a payslip id.
  @Get('pending-mine')
  pendingMine(@CurrentUser() caller: Caller) {
    return this.payrollService.pendingPayslipMonths(
      caller,
      caller.organizationId,
    );
  }

  // No @Roles() — self/dept/org scoping all enforced inline in the
  // service: EMPLOYEE and MANAGER 403 on anyone else's payslip,
  // ADMIN/HR unrestricted.
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.findOne(id, caller, caller.organizationId);
  }

  // Self-scoped for EMPLOYEE (findOne already 403s otherwise); blocked
  // unless the run has passed approval, matching the old system's
  // downloadPayslipPdf exactly.
  @Get(':id/pdf')
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async downloadPdf(
    @Param('id') id: string,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const run = await this.payrollService.findOne(
      id,
      caller,
      caller.organizationId,
    );
    if (!FINALIZED_STATUSES.includes(run.status)) {
      throw new BadRequestException('This payslip is not finalized yet.');
    }
    const { buffer, filename } =
      await this.payslipPdfService.buildPayslipPdfBuffer(
        id,
        caller.organizationId,
      );
    auditSensitive(this.privacyAudit, caller, {
      action: 'PAYSLIP_DOWNLOADED',
      category: 'PAYSLIP',
      targetUserId: run.employeeId,
      entity: 'PayrollRun',
      entityId: id,
    });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=${filename}`,
    });
    res.send(buffer);
  }

  // The figures a run was finalised with before each correction (ADMIN/HR).
  @Get(':id/revisions')
  @Roles(Role.ADMIN, Role.HR)
  revisions(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.listRevisions(id, caller.organizationId);
  }

  @Get(':id/revisions/:revision')
  @Roles(Role.ADMIN, Role.HR)
  revision(
    @Param('id') id: string,
    @Param('revision', ParseIntPipe) revision: number,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.getRevision(id, revision, caller.organizationId);
  }

  // The payslip as it was issued in that earlier version of the run.
  @Get(':id/revisions/:revision/pdf')
  @Roles(Role.ADMIN, Role.HR)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async revisionPdf(
    @Param('id') id: string,
    @Param('revision', ParseIntPipe) revision: number,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const { buffer, filename } =
      await this.payslipPdfService.buildRevisionPayslipPdfBuffer(
        id,
        revision,
        caller.organizationId,
      );
    auditSensitive(this.privacyAudit, caller, {
      action: 'PAYSLIP_DOWNLOADED',
      category: 'PAYSLIP',
      entity: 'PayrollRunRevision',
      entityId: `${id}#${revision}`,
    });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=${filename}`,
    });
    res.send(buffer);
  }

  // The salary-structure builder: from a package (annual CTC or monthly gross) the breakup that follows the Labour Codes,
  // with HRA by where the employee is hired and the schemes that apply to their type. Nothing is saved.
  @Post('structure-preview')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  structurePreview(
    @Body() dto: StructurePreviewDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.previewStructure(dto, caller.organizationId);
  }

  @Post('draft')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  draft(@Body() dto: DraftPayrollDto, @CurrentUser() caller: Caller) {
    return this.payrollService.draft(dto, caller, caller.organizationId);
  }

  @Post('calculate')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  calculate(@Body() dto: CalculatePayrollDto, @CurrentUser() caller: Caller) {
    return this.payrollService.calculate(dto, caller, caller.organizationId);
  }

  @Post('supplementary')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  createSupplementary(
    @Body() dto: CreateSupplementaryPayrollDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.createSupplementary(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Get('integrity/lock-effects')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  lockEffectsPending(@CurrentUser() caller: Caller) {
    return this.payrollService.lockEffectsPending(caller.organizationId);
  }

  @Post(':id/reapply-lock-effects')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  reapplyLockEffects(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.reapplyLockEffects(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Post('payments/import')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  importPayments(
    @Body() dto: ImportPaymentsDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.importPayments(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Patch(':id/payment')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  recordPayment(
    @Param('id') id: string,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.recordPayment(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Post('arrears/preview')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  previewArrears(
    @Body() dto: ArrearsPreviewDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.previewArrears(dto, caller.organizationId);
  }

  @Post('arrears')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  createArrears(@Body() dto: CreateArrearsDto, @CurrentUser() caller: Caller) {
    return this.payrollService.createArrears(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Delete('supplementary/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  removeSupplementary(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.removeSupplementary(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  adjust(
    @Param('id') id: string,
    @Body() dto: AdjustPayrollDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.adjust(id, dto, caller, caller.organizationId);
  }

  @Post('bulk-transition')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  bulkTransition(
    @Body() dto: BulkTransitionPayrollDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.bulkTransition(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Post(':id/verify')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  verify(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.verify(id, caller, caller.organizationId);
  }

  @Post(':id/approve')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  approve(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.approve(id, caller, caller.organizationId);
  }

  @Post(':id/lock')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  lock(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.lock(id, caller, caller.organizationId);
  }

  @Post(':id/pay')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  pay(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.pay(id, caller, caller.organizationId);
  }

  // Old system's PAYROLL_UNLOCK_ROLES (hr_admin, payroll_manager,
  // administrator) collapses to the same [ADMIN, HR] set as every other
  // payroll-workflow action here.
  @Post(':id/unlock')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  unlock(
    @Param('id') id: string,
    @Body() dto: UnlockPayrollDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.unlock(id, dto, caller, caller.organizationId);
  }
}
