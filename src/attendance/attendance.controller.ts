// Purpose: Exposes punch in/out, work-arrangement, regularization, import-batch, and absentee-notification endpoints.
// Responsibilities: Validates DTOs and delegates all business logic to AttendanceService.
// Important: punch/ingest is @Public(), authenticated by a shared-secret x-face-api-key header instead of a JWT.
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import { AttendanceService } from './attendance.service';
import { IngestPunchDto } from './dto/ingest-punch.dto';
import { ManualPunchDto } from './dto/manual-punch.dto';
import { SelfPunchDto } from './dto/self-punch.dto';
import { SetWorkArrangementDto } from './dto/set-work-arrangement.dto';
import { QueryAttendanceDto } from './dto/query-attendance.dto';
import { RequestRegularizationDto } from './dto/request-regularization.dto';
import { ReviewRegularizationDto } from './dto/review-regularization.dto';
import { PreviewWfhDaysQueryDto } from './dto/preview-wfh-days-query.dto';
import { DecidedWfhQueryDto } from './dto/decided-wfh-query.dto';
import { ReviewWfhDto } from './dto/review-wfh.dto';
import { ImportWfhDto } from './dto/import-wfh.dto';
import { UploadImportBatchDto } from './dto/upload-import-batch.dto';
import { NotifyAbsenteesDto } from './dto/notify-absentees.dto';
import { BackfillAttendanceDto } from './dto/backfill-attendance.dto';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';

type Caller = Omit<User, 'password'>;

@ApiTags('attendance')
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  // Machine-to-machine webhook from the Face API device — exempt from the
  // global JwtAuthGuard, authenticated instead by a shared-secret header.
  //
  // Deliberately left on the app-wide throttle (300 req/min per IP) rather
  // than a tighter per-route one: the key is 24 random bytes per org
  // (OrganizationSettingsService.regenerateFaceApiKey), so guessing it is
  // infeasible at any rate limit, while a device gateway relaying a whole
  // site's punches at shift start is exactly the burst a tighter limit
  // would start dropping.
  @Post('punch/ingest')
  @Public()
  @ApiHeader({ name: 'x-face-api-key', required: true })
  ingestPunch(
    @Body() dto: IngestPunchDto,
    @Headers('x-face-api-key') apiKey: string | undefined,
  ) {
    return this.attendanceService.ingestFaceApiPunch(dto, apiKey);
  }

  @Post('punch/manual')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  manualPunch(@Body() dto: ManualPunchDto, @CurrentUser() caller: Caller) {
    return this.attendanceService.manualPunch(
      dto,
      caller.organizationId,
      caller.id,
    );
  }

  // No @Roles() — any authenticated caller punches for themselves only.
  @Post('punch/self')
  @ApiBearerAuth('access-token')
  selfPunch(@Body() dto: SelfPunchDto, @CurrentUser() caller: Caller) {
    return this.attendanceService.selfPunch(dto, caller, caller.organizationId);
  }

  @Get('punch/today')
  @ApiBearerAuth('access-token')
  getTodayPunchStatus(@CurrentUser() caller: Caller) {
    return this.attendanceService.getTodayPunchCount(
      caller,
      caller.organizationId,
    );
  }

  // Work From Home usage for the employee profile (days used / upcoming / awaiting approval). Own by default;
  // Admin/HR/Manager can pass an employeeId. Literal path, before any :id route.
  @Get('wfh-summary')
  @ApiBearerAuth('access-token')
  wfhSummary(
    @Query('employeeId') employeeId: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.getWfhSummary(
      employeeId,
      caller,
      caller.organizationId,
    );
  }

  @Put('work-arrangement')
  @ApiBearerAuth('access-token')
  setWorkArrangement(
    @Body() dto: SetWorkArrangementDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.setWorkArrangement(
      dto,
      caller,
      caller.organizationId,
    );
  }

  // Migration of past, already-approved Work From Home from a spreadsheet (Admin/HR). dryRun (the default) only checks
  // every row. POST, so it never meets the :id review routes.
  @Post('work-arrangement/import')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  importWfh(@Body() dto: ImportWfhDto, @CurrentUser() caller: Caller) {
    return this.attendanceService.importWfh(dto, caller, caller.organizationId);
  }

  // What a multi-day request would cover (nothing is written). Literal path, registered before the :id routes.
  @Get('work-arrangement/preview-days')
  previewWfhDays(
    @Query() query: PreviewWfhDaysQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.previewWfhDays(
      query,
      caller,
      caller.organizationId,
    );
  }

  // Literal path, so it must be registered before Patch('work-arrangement/:id/review').
  @Get('work-arrangement/pending')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  listPendingWfhRequests(@CurrentUser() caller: Caller) {
    return this.attendanceService.listPendingWfhRequests(
      caller,
      caller.organizationId,
    );
  }

  // Already-decided (approved / rejected) Work From Home days, with who decided them and any remarks.
  // Literal path, registered before the ':id' routes.
  @Get('work-arrangement/decided')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  listDecidedWfhRequests(
    @Query() query: DecidedWfhQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.listDecidedWfhRequests(
      caller,
      caller.organizationId,
      query,
    );
  }

  // Decide every pending day of a multi-day Work From Home request at once (the id is the request id the days share).
  // Two path segments, so it never collides with the single-day ':id/review' below.
  @Patch('work-arrangement/group/:requestId/review')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  reviewWfhRequestGroup(
    @Param('requestId') requestId: string,
    @Body() dto: ReviewWfhDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.reviewWfhRequestGroup(
      requestId,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Patch('work-arrangement/:id/review')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  reviewWorkArrangement(
    @Param('id') id: string,
    @Body() dto: ReviewWfhDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.reviewWorkArrangement(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Get('geofence/mine')
  @ApiBearerAuth('access-token')
  getMyGeoFence(@CurrentUser() caller: Caller) {
    return this.attendanceService.getMyGeoFence(caller, caller.organizationId);
  }

  // One employee's day (record, overtime, shift, time beyond shift) for the Attendance Tracker popup. Literal path, before the :id routes.
  @Get('day-detail')
  @ApiBearerAuth('access-token')
  dayDetail(@Query('employeeId') employeeId: string, @Query('date') date: string, @CurrentUser() caller: Caller) {
    return this.attendanceService.getDayDetail(employeeId, date, caller, caller.organizationId);
  }

  @Get()
  @ApiBearerAuth('access-token')
  list(@Query() query: QueryAttendanceDto, @CurrentUser() caller: Caller) {
    return this.attendanceService.list(query, caller, caller.organizationId);
  }

  // No @Roles() — any authenticated caller requests for themselves only.
  @Post('regularization')
  @ApiBearerAuth('access-token')
  requestRegularization(
    @Body() dto: RequestRegularizationDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.requestRegularization(
      dto,
      caller,
      caller.organizationId,
    );
  }

  // No @Roles() - the form's lookback window, needed by every employee.
  @Get('regularization/settings')
  @ApiBearerAuth('access-token')
  regularizationSettings(@CurrentUser() caller: Caller) {
    return this.attendanceService.getRegularizationSettings(
      caller.organizationId,
    );
  }

  // No @Roles() - the caller's own standing against the Admin-set regularization caps for a date's month. Declared
  // before the ':id' routes so "usage" is not read as an id.
  @Get('regularization/usage')
  @ApiBearerAuth('access-token')
  regularizationUsage(
    @Query('date') date: string,
    @CurrentUser() caller: Caller,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
      throw new BadRequestException('date must be YYYY-MM-DD.');
    }
    return this.attendanceService.getRegularizationUsage(
      caller.id,
      date,
      caller.organizationId,
    );
  }

  // The employee withdraws their own pending request (ownership is checked in the service).
  @Delete('regularization/:id')
  @ApiBearerAuth('access-token')
  cancelRegularization(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.attendanceService.cancelRegularization(
      id,
      caller,
      caller.organizationId,
    );
  }

  // Every request ever made for that day (employee: own; manager: team; HR/Admin: any).
  @Get(':id/regularization-history')
  @ApiBearerAuth('access-token')
  regularizationHistory(
    @Param('id') id: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.getRegularizationHistory(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Patch('regularization/:id')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  reviewRegularization(
    @Param('id') id: string,
    @Body() dto: ReviewRegularizationDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.reviewRegularization(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Post('import')
  @Roles(Role.MANAGER, Role.HR, Role.ADMIN)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  uploadImportBatch(
    @Body() dto: UploadImportBatchDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.uploadImportBatch(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Get('import')
  @Roles(Role.HR, Role.MANAGER, Role.ADMIN)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  listImportBatches(@CurrentUser() caller: Caller) {
    return this.attendanceService.listImportBatches(
      caller,
      caller.organizationId,
    );
  }

  @Post('import/:id/validate')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  validateImportBatch(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.attendanceService.validateImportBatch(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Post('import/:id/execute')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  executeImportBatch(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.attendanceService.executeImportBatch(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Post('import/:id/reject')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  rejectImportBatch(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.attendanceService.rejectImportBatch(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Post('notify-absentees')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  notifyAbsentees(
    @Body() dto: NotifyAbsenteesDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.notifyAbsentees(dto, caller.organizationId);
  }

  // Turns empty Absent rows on reference (past-dated) holidays into Holiday, in months whose payroll is still open.
  @Post('apply-reference-holidays')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  applyReferenceHolidays(@CurrentUser() caller: Caller) {
    return this.attendanceService.applyReferenceHolidays(
      caller.organizationId,
      caller.id,
    );
  }

  // One-off repair of HR users' missing weekend/holiday/absent rows (see AttendanceService.backfillMissingAttendance).
  // Admin only: it writes attendance that payroll then pays against. Dry run unless dryRun is false.
  @Post('backfill-missing')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
  backfillMissing(
    @Body() dto: BackfillAttendanceDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.attendanceService.backfillMissingAttendance(
      dto,
      caller,
      caller.organizationId,
    );
  }
}
