import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { AttendanceService } from './attendance.service';
import { IngestPunchDto } from './dto/ingest-punch.dto';
import { ManualPunchDto } from './dto/manual-punch.dto';
import { SelfPunchDto } from './dto/self-punch.dto';
import { SetWorkArrangementDto } from './dto/set-work-arrangement.dto';
import { QueryAttendanceDto } from './dto/query-attendance.dto';
import { RequestRegularizationDto } from './dto/request-regularization.dto';
import { ReviewRegularizationDto } from './dto/review-regularization.dto';
import { UploadImportBatchDto } from './dto/upload-import-batch.dto';
import { NotifyAbsenteesDto } from './dto/notify-absentees.dto';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('attendance')
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  // Machine-to-machine webhook from the Face API device — exempt from the
  // global JwtAuthGuard, authenticated instead by a shared-secret header.
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
    return this.attendanceService.manualPunch(dto, caller.organizationId);
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

  @Get('geofence/mine')
  @ApiBearerAuth('access-token')
  getMyGeoFence(@CurrentUser() caller: Caller) {
    return this.attendanceService.getMyGeoFence(caller, caller.organizationId);
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

  @Patch('regularization/:id')
  @Roles(Role.HR, Role.MANAGER)
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
  @Roles(Role.MANAGER, Role.HR)
  @UseGuards(RolesGuard)
  @ApiBearerAuth('access-token')
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
  @Roles(Role.HR, Role.MANAGER)
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
}
