// Purpose: Exposes endpoints to log, list, and review overtime entries.
// Responsibilities: Validates DTOs and delegates all logic to OvertimeService.
// Important: Only review is gated to ADMIN/HR/MANAGER; findAll/log have no @Roles() and self-scope for EMPLOYEE in the service.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { OvertimeService } from './overtime.service';
import { OvertimeRuleSetsService } from './overtime-rule-sets.service';
import { OvertimeReportService } from './overtime-report.service';
import { IsNumber, IsOptional, IsString, ValidateIf } from 'class-validator';
import { SaveOvertimeRuleSetDto, PreviewOvertimeRuleDto } from './dto/overtime-rule-set.dto';
import { LogOvertimeDto } from './dto/log-overtime.dto';
import { ReviewOvertimeDto } from './dto/review-overtime.dto';
import { QueryOvertimeDto } from './dto/query-overtime.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

class OvertimeBudgetDto {
  @IsString()
  departmentId!: string;

  // A number of hours per month, or null to remove the budget.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber()
  hours?: number | null;
}

@ApiTags('overtime')
@ApiBearerAuth('access-token')
@Controller('overtime')
export class OvertimeController {
  constructor(
    private readonly overtimeService: OvertimeService,
    private readonly ruleSets: OvertimeRuleSetsService,
    private readonly reportService: OvertimeReportService,
  ) {}

  // ---- Overtime report and department budgets (Admin / HR) ----
  @Get('report')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  report(
    @Query('month') month: string,
    @Query('year') year: string,
    @CurrentUser() caller: Caller,
  ) {
    const now = new Date();
    return this.reportService.report(
      Number(month) || now.getUTCMonth() + 1,
      Number(year) || now.getUTCFullYear(),
      caller.organizationId,
    );
  }

  @Patch('budget')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  setBudget(@Body() dto: OvertimeBudgetDto, @CurrentUser() caller: Caller) {
    return this.reportService.setBudget(
      dto.departmentId,
      dto.hours ?? null,
      caller.organizationId,
      caller.id,
    );
  }

  // ---- Overtime rule sets (Admin / HR of the organisation) ----
  @Get('rule-sets')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  listRuleSets(@CurrentUser() caller: Caller) {
    return this.ruleSets.list(caller.organizationId);
  }

  @Post('rule-sets')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  createRuleSet(@Body() dto: SaveOvertimeRuleSetDto, @CurrentUser() caller: Caller) {
    return this.ruleSets.create(dto, caller.organizationId, caller);
  }

  @Post('rule-sets/preview')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  previewRuleSet(@Body() dto: PreviewOvertimeRuleDto, @CurrentUser() caller: Caller) {
    return this.ruleSets.preview(dto.employeeId, dto.date, caller.organizationId);
  }

  @Patch('rule-sets/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateRuleSet(@Param('id') id: string, @Body() dto: SaveOvertimeRuleSetDto, @CurrentUser() caller: Caller) {
    return this.ruleSets.update(id, dto, caller.organizationId, caller);
  }

  @Delete('rule-sets/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  removeRuleSet(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.ruleSets.remove(id, caller.organizationId, caller);
  }


  // No @Roles() — the org's overtime multipliers, for the log form.
  @Get('rates')
  getRates(@CurrentUser() caller: Caller) {
    return this.overtimeService.getRates(caller.organizationId, caller);
  }

  // No @Roles() — whether overtime is currently paid (Overtime Pay component active), so clients can hide the log form.
  @Get('status')
  status(@CurrentUser() caller: Caller) {
    return this.overtimeService.status(caller.organizationId);
  }

  // No @Roles() — the Admin's overtime policy plus the caller's own usage this month (for the log form's hints).
  @Get('policy')
  myPolicy(@CurrentUser() caller: Caller) {
    return this.overtimeService.myPolicy(caller, caller.organizationId);
  }

  // No @Roles() — the weekend/holiday compensation options an approver can choose from, and the default.
  @Get('compensation-options')
  compensationOptions(
    @CurrentUser() caller: Caller,
    @Query('employeeId') employeeId?: string,
    @Query('date') date?: string,
  ) {
    return this.overtimeService.compensationOptionsFor(
      caller.organizationId,
      employeeId,
      date,
    );
  }

  // No @Roles() — any authenticated caller can view (self-scoped for
  // EMPLOYEE, service-side).
  @Get()
  findAll(@Query() query: QueryOvertimeDto, @CurrentUser() caller: Caller) {
    return this.overtimeService.findAll(query, caller, caller.organizationId);
  }

  // No @Roles() — any authenticated caller logs their own overtime only.
  @Post()
  log(@Body() dto: LogOvertimeDto, @CurrentUser() caller: Caller) {
    return this.overtimeService.log(dto, caller, caller.organizationId);
  }

  @Patch(':id/review')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  review(
    @Param('id') id: string,
    @Body() dto: ReviewOvertimeDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.overtimeService.review(id, dto, caller, caller.organizationId);
  }
}
