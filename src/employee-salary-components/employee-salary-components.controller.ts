// Purpose: Exposes endpoints for viewing and setting an employee's salary component structure and history.
// Responsibilities: Validates DTOs and delegates all logic to EmployeeSalaryComponentsService.
// Important: getStructure uses @SelfOrRoles so an employee can view their own structure; writes are ADMIN/HR only.
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ForbiddenException } from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { EmployeeSalaryComponentsService } from './employee-salary-components.service';
import { SalaryStructurePdfService } from './salary-structure-pdf.service';
import { PrivacyAuditService } from '../privacy/privacy-audit.service';
import { auditSensitive } from '../common/sensitive-audit';
import { SetComponentValueDto } from './dto/set-component-value.dto';
import { BulkSetStructureDto } from './dto/bulk-set-structure.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { SelfOrRoles } from '../common/decorators/self-or-roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

// Only an Admin may set or revise their OWN salary structure; HR (and everyone else) needs another person to do it.
// An Admin is the organisation's top authority and has no one above them to ask, so the rule that a second person
// changes the structure stops at Admin. The change is still audited with selfRevision = true (see the service).
function assertMayChangeSalaryOf(caller: Caller, employeeId: string): void {
  if (caller.id === employeeId && caller.role !== Role.ADMIN) {
    throw new ForbiddenException(
      'You cannot change your own salary structure. An Admin must do it.',
    );
  }
}

@ApiTags('employee-salary')
@ApiBearerAuth('access-token')
@Controller('employee-salary')
export class EmployeeSalaryComponentsController {
  constructor(
    private readonly employeeSalaryComponentsService: EmployeeSalaryComponentsService,
    private readonly salaryStructurePdf: SalaryStructurePdfService,
    private readonly privacyAudit: PrivacyAuditService,
  ) {}

  // Employees whose Basic + DA is under 50% of the monthly pay (new Labour Code), for HR to correct.
  @Get('basic-share/below-half')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  listBelowHalfBasic(@CurrentUser() caller: Caller) {
    return this.employeeSalaryComponentsService.listBelowHalfBasic(
      caller.organizationId,
    );
  }

  @Get(':id/structure')
  @SelfOrRoles('id', Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  getStructure(
    @Param('id') id: string,
    @Query('asOf') asOf: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeSalaryComponentsService.getStructure(
      id,
      asOf,
      caller.organizationId,
    );
  }

  // The one-page Salary Structure document (what the Print button shows and what is mailed after a revision).
  // Same access as the structure itself: the employee, HR or an Admin.
  @Get(':id/structure/pdf')
  @SelfOrRoles('id', Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async structurePdf(
    @Param('id') id: string,
    @Query('asOf') asOf: string | undefined,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.salaryStructurePdf.build(
      id,
      caller.organizationId,
      asOf,
    );
    // A salary document leaves the system here, so it is on the sensitive-access trail like a payslip download.
    auditSensitive(this.privacyAudit, caller, {
      action: 'SALARY_STRUCTURE_DOWNLOADED',
      category: 'PAYROLL',
      targetUserId: id,
      entity: 'EmployeeSalaryStructure',
      entityId: id,
    });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
    });
    res.send(buffer);
  }

  @Get(':id/history')
  @SelfOrRoles('id', Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  getHistory(
    @Param('id') id: string,
    @Query('componentCode') componentCode: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeSalaryComponentsService.getHistory(
      id,
      componentCode,
      caller.organizationId,
    );
  }

  @Post(':id/structure')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  setComponentValue(
    @Param('id') id: string,
    @Body() dto: SetComponentValueDto,
    @CurrentUser() caller: Caller,
  ) {
    assertMayChangeSalaryOf(caller, id);
    return this.employeeSalaryComponentsService.setComponentValue(
      id,
      dto,
      caller.id,
      caller.organizationId,
    );
  }

  @Post(':id/structure/bulk')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  bulkSetStructure(
    @Param('id') id: string,
    @Body() dto: BulkSetStructureDto,
    @CurrentUser() caller: Caller,
  ) {
    assertMayChangeSalaryOf(caller, id);
    return this.employeeSalaryComponentsService.bulkSetStructure(
      id,
      dto,
      caller.id,
      caller.organizationId,
    );
  }
}
