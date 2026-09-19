// Purpose: Employee self-service HTTP surface of the privacy module (prefix /privacy/me).
// Responsibilities: Current notice + acknowledgement, my-data summary, own data-principal requests (create / list /
// get / cancel / export download), consents and the privacy contact.
// Important: No @Roles() — any authenticated role may use these, and every handler is scoped to the caller's own
// id (never a path/body user id), so there is no way to read another person's data through this controller.
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrivacyMeService } from './privacy-me.service';
import { PrivacyRequestsService } from './privacy-requests.service';
import { reqCtx } from './privacy.types';
import type { Caller } from './privacy.types';
import { AcknowledgeNoticeDto } from './dto/privacy-notice.dto';
import { CreateDataRequestDto } from './dto/data-request.dto';
import { ConsentActionDto } from './dto/consent.dto';

@ApiTags('privacy')
@ApiBearerAuth('access-token')
@Controller('privacy/me')
export class PrivacyMeController {
  constructor(
    private readonly me: PrivacyMeService,
    private readonly requests: PrivacyRequestsService,
  ) {}

  @Get('notice')
  getNotice(@CurrentUser() caller: Caller) {
    return this.me.getNotice(caller);
  }

  @Post('notice/acknowledge')
  acknowledge(
    @Body() dto: AcknowledgeNoticeDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.me.acknowledgeNotice(dto.noticeVersionId, caller, reqCtx(req));
  }

  @Get('data-summary')
  summary(@CurrentUser() caller: Caller, @Req() req: Request) {
    return this.me.getSummary(caller, reqCtx(req));
  }

  @Get('contact')
  contact(@CurrentUser() caller: Caller) {
    return this.me.getContact(caller.organizationId);
  }

  @Post('requests')
  createRequest(
    @Body() dto: CreateDataRequestDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.requests.create(dto, caller, reqCtx(req));
  }

  @Get('requests')
  listRequests(@CurrentUser() caller: Caller) {
    return this.requests.listMine(caller);
  }

  @Get('requests/:id')
  getRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.requests.getMine(id, caller);
  }

  @Post('requests/:id/cancel')
  cancelRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.requests.cancelMine(id, caller, reqCtx(req));
  }

  @Get('requests/:id/download')
  download(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.requests.downloadMine(id, caller, reqCtx(req));
  }

  @Get('consents')
  consents(@CurrentUser() caller: Caller) {
    return this.me.listConsents(caller);
  }

  @Post('consents/:purposeKey/grant')
  grant(
    @Param('purposeKey') purposeKey: string,
    @Body() dto: ConsentActionDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.me.grant(purposeKey, dto.source, caller, reqCtx(req));
  }

  @Post('consents/:purposeKey/withdraw')
  withdraw(
    @Param('purposeKey') purposeKey: string,
    @Body() dto: ConsentActionDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.me.withdraw(purposeKey, dto.source, caller, reqCtx(req));
  }
}
