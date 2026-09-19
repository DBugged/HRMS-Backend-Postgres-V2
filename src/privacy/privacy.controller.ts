// Purpose: Admin/HR HTTP surface of the Data Privacy & Protection module (prefix /privacy).
// Responsibilities: Settings, notice versions, processor register, sharing records, breach incidents, audit-log
// list + chain verification, retention review (ADMIN only); request handling (HR + ADMIN). DTO validation and
// delegation only — logic lives in PrivacyService / PrivacyRequestsService / PrivacyAuditService.
// Important: The audit log has read + verify endpoints only; there is deliberately no update/delete route. Employee
// self-service lives in PrivacyMeController (/privacy/me/*).
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrivacyService } from './privacy.service';
import { PrivacyRequestsService } from './privacy-requests.service';
import { PrivacyAuditService } from './privacy-audit.service';
import { reqCtx } from './privacy.types';
import type { Caller } from './privacy.types';
import { UpdatePrivacySettingsDto } from './dto/update-privacy-settings.dto';
import {
  CreatePrivacyNoticeDto,
  PublishPrivacyNoticeDto,
  UpdatePrivacyNoticeDraftDto,
} from './dto/privacy-notice.dto';
import {
  CreateDataProcessorDto,
  UpdateDataProcessorDto,
} from './dto/data-processor.dto';
import {
  CreateDataSharingDto,
  UpdateDataSharingDto,
} from './dto/data-sharing.dto';
import {
  CloseBreachDto,
  CreateBreachDto,
  ListBreachesQueryDto,
  UpdateBreachDto,
} from './dto/breach-incident.dto';
import { QueryPrivacyAuditDto } from './dto/query-privacy-audit.dto';
import {
  AssignDataRequestDto,
  CompleteDataRequestDto,
  ListDataRequestsQueryDto,
  ReviewDataRequestDto,
} from './dto/data-request.dto';

@ApiTags('privacy')
@ApiBearerAuth('access-token')
@Controller('privacy')
export class PrivacyController {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly requests: PrivacyRequestsService,
    private readonly audit: PrivacyAuditService,
  ) {}

  // -- settings (ADMIN) --

  @Get('settings')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  getSettings(@CurrentUser() caller: Caller) {
    return this.privacy.getSettings(caller.organizationId);
  }

  @Put('settings')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  updateSettings(
    @Body() dto: UpdatePrivacySettingsDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.updateSettings(dto, caller, reqCtx(req));
  }

  // -- notice versions (ADMIN) --

  @Get('notices')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  listNotices(@CurrentUser() caller: Caller) {
    return this.privacy.listNotices(caller.organizationId);
  }

  @Post('notices')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  createNotice(
    @Body() dto: CreatePrivacyNoticeDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.createNotice(dto, caller, reqCtx(req));
  }

  @Put('notices/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  updateNoticeDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePrivacyNoticeDraftDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.updateNoticeDraft(id, dto, caller, reqCtx(req));
  }

  @Post('notices/:id/publish')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  publishNotice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishPrivacyNoticeDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.publishNotice(id, dto, caller, reqCtx(req));
  }

  // -- processors (ADMIN) --

  @Get('processors')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  listProcessors(@CurrentUser() caller: Caller) {
    return this.privacy.listProcessors(caller.organizationId);
  }

  @Post('processors')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  createProcessor(
    @Body() dto: CreateDataProcessorDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.createProcessor(dto, caller, reqCtx(req));
  }

  @Put('processors/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  updateProcessor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDataProcessorDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.updateProcessor(id, dto, caller, reqCtx(req));
  }

  @Delete('processors/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  removeProcessor(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.removeProcessor(id, caller, reqCtx(req));
  }

  // -- data sharing (ADMIN) --

  @Get('sharing')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  listSharing(@CurrentUser() caller: Caller) {
    return this.privacy.listSharing(caller.organizationId);
  }

  @Post('sharing')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  createSharing(
    @Body() dto: CreateDataSharingDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.createSharing(dto, caller, reqCtx(req));
  }

  @Put('sharing/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  updateSharing(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDataSharingDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.updateSharing(id, dto, caller, reqCtx(req));
  }

  @Delete('sharing/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  removeSharing(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.removeSharing(id, caller, reqCtx(req));
  }

  // -- breaches (ADMIN) --

  @Get('breaches')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  listBreaches(
    @Query() query: ListBreachesQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.privacy.listBreaches(query, caller.organizationId);
  }

  @Post('breaches')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  createBreach(
    @Body() dto: CreateBreachDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.createBreach(dto, caller, reqCtx(req));
  }

  @Get('breaches/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  getBreach(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.privacy.getBreach(id, caller.organizationId);
  }

  @Put('breaches/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  updateBreach(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBreachDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.updateBreach(id, dto, caller, reqCtx(req));
  }

  @Post('breaches/:id/close')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  closeBreach(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseBreachDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.closeBreach(id, dto, caller, reqCtx(req));
  }

  @Delete('breaches/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  removeBreach(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.privacy.removeBreach(id, caller, reqCtx(req));
  }

  // -- audit log (ADMIN, read-only) --

  @Get('audit-log')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  listAudit(
    @Query() query: QueryPrivacyAuditDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.audit.findAll(query, caller.organizationId);
  }

  @Get('audit-log/verify')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  verifyAudit(@CurrentUser() caller: Caller) {
    return this.audit.verifyChain(caller.organizationId);
  }

  // -- retention review (ADMIN, report only) --

  @Get('retention-review')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  retentionReview(@CurrentUser() caller: Caller, @Req() req: Request) {
    return this.privacy.retentionReview(caller, reqCtx(req));
  }

  // -- data-principal requests (HR + ADMIN) --

  @Get('requests')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  listRequests(
    @Query() query: ListDataRequestsQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.requests.listAll(query, caller.organizationId);
  }

  @Get('requests/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  getRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.requests.getOne(id, caller, reqCtx(req));
  }

  @Post('requests/:id/assign')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  assignRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignDataRequestDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.requests.assign(id, dto, caller, reqCtx(req));
  }

  @Post('requests/:id/review')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  reviewRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDataRequestDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.requests.review(id, dto, caller, reqCtx(req));
  }

  @Post('requests/:id/complete')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  completeRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteDataRequestDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.requests.complete(id, dto, caller, reqCtx(req));
  }
}
