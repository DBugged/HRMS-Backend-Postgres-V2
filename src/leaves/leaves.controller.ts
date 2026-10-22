// Purpose: Exposes endpoints to apply for, list, update, review, and cancel leave requests, plus balance/team-calendar views.
// Responsibilities: Validates DTOs and delegates all logic to LeavesService.
// Important: Most routes have no @Roles() and self-scope in the service; team-calendar/credit-history/review are ADMIN/HR/MANAGER.
import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { LeavesService } from './leaves.service';
import { PreviewLeaveDaysQueryDto } from './dto/preview-leave-days-query.dto';
import { ApplyLeaveDto } from './dto/apply-leave.dto';
import { ImportLeavesDto } from './dto/import-leaves.dto';
import { UpdateLeaveDto } from './dto/update-leave.dto';
import { ReviewLeaveDto } from './dto/review-leave.dto';
import { ListLeavesQueryDto } from './dto/list-leaves-query.dto';
import { TeamCalendarQueryDto } from './dto/team-calendar-query.dto';
import {
  DecideLeaveCancelDto,
  RequestLeaveCancelDto,
} from './dto/leave-cancel-request.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('leaves')
@ApiBearerAuth('access-token')
@Controller('leaves')
export class LeavesController {
  constructor(private readonly leavesService: LeavesService) {}

  // Migration of past, already-approved leave from a spreadsheet (Admin/HR). dryRun (the default) only checks every row.
  // Declared before the parameterised routes.
  @Post('import')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  importLeaves(@Body() dto: ImportLeavesDto, @CurrentUser() caller: Caller) {
    return this.leavesService.importLeaves(dto, caller, caller.organizationId);
  }

  @Post()
  apply(@Body() dto: ApplyLeaveDto, @CurrentUser() caller: Caller) {
    return this.leavesService.apply(dto, caller, caller.organizationId);
  }

  // How many days these dates would cost (nothing is written) - shown in the Apply for Leave form as dates are
  // picked. Declared before the parameterised routes.
  @Get('preview-days')
  previewDays(
    @Query() query: PreviewLeaveDaysQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.previewDays(query, caller, caller.organizationId);
  }

  @Get()
  findAll(@Query() query: ListLeavesQueryDto, @CurrentUser() caller: Caller) {
    return this.leavesService.findAll(query, caller, caller.organizationId);
  }

  @Get('balance')
  balance(
    @Query('employeeId') employeeId: string | undefined,
    @Query('year') year: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    // Raw string query param (not a DTO): a non-numeric or absurd year used to reach Prisma and 500.
    const parsedYear = year ? Number(year) : undefined;
    if (
      parsedYear !== undefined &&
      (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 2100)
    ) {
      throw new BadRequestException(
        'year must be an integer between 2000 and 2100',
      );
    }
    return this.leavesService.getBalance(
      employeeId,
      parsedYear,
      caller,
      caller.organizationId,
    );
  }

  @Get('accrual-history')
  accrualHistory(
    @Query('employeeId') employeeId: string | undefined,
    @Query('year') year: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    const parsedYear = year ? Number(year) : undefined;
    if (
      parsedYear !== undefined &&
      (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 2100)
    ) {
      throw new BadRequestException(
        'year must be an integer between 2000 and 2100',
      );
    }
    return this.leavesService.getAccrualHistory(
      employeeId,
      parsedYear,
      caller,
      caller.organizationId,
    );
  }

  @Get('team-calendar')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  teamCalendar(
    @Query() query: TeamCalendarQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.getTeamCalendar(
      query,
      caller,
      caller.organizationId,
    );
  }

  // No @Roles(): every employee may see who is away (approved leave only, no type or remarks - see the service).
  @Get('whos-out')
  whosOut(@Query() query: TeamCalendarQueryDto, @CurrentUser() caller: Caller) {
    return this.leavesService.getWhosOut(query, caller, caller.organizationId);
  }

  @Get('credit-history')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  creditHistory(@CurrentUser() caller: Caller) {
    return this.leavesService.getCreditHistory(caller.organizationId);
  }

  @Get('history/:employeeId')
  history(
    @Param('employeeId') employeeId: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.getHistory(
      employeeId,
      caller,
      caller.organizationId,
    );
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLeaveDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.update(id, dto, caller, caller.organizationId);
  }

  @Patch(':id/review')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  review(
    @Param('id') id: string,
    @Body() dto: ReviewLeaveDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.review(id, dto, caller, caller.organizationId);
  }

  @Patch(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.leavesService.cancel(id, caller, caller.organizationId);
  }

  // The owner asks for an approved, already-started leave to be cancelled.
  @Post(':id/cancel-request')
  requestCancel(
    @Param('id') id: string,
    @Body() dto: RequestLeaveCancelDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.requestCancel(id, dto, caller, caller.organizationId);
  }

  // A manager / HR / Admin approves or declines that request.
  @Patch(':id/cancel-request')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  decideCancelRequest(
    @Param('id') id: string,
    @Body() dto: DecideLeaveCancelDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.decideCancelRequest(id, dto, caller, caller.organizationId);
  }
}
