// Purpose: Exposes the full offboarding workflow — initiate, checklist, exit interview, settlement link, complete/cancel.
// Responsibilities: Validates DTOs and delegates all logic to OffboardingService.
// Important: [ADMIN, HR] applies to every endpoint at the controller level — unlike most modules, there is no self-service path.
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { OffboardingService } from './offboarding.service';
import { InitiateOffboardingDto } from './dto/initiate-offboarding.dto';
import { UpdateChecklistDto } from './dto/update-checklist.dto';
import { SubmitExitInterviewDto } from './dto/submit-exit-interview.dto';
import { LinkSettlementDto } from './dto/link-settlement.dto';
import { ListOffboardingQueryDto } from './dto/list-offboarding-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

// Old system's whole router is authorize('hr_admin', 'administrator') —
// unlike every other module here, there's no self-service employee access
// at all, so the [ADMIN, HR] gate applies to every endpoint, not per-route.
@ApiTags('offboarding')
@ApiBearerAuth('access-token')
@Controller('offboarding')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class OffboardingController {
  constructor(private readonly offboardingService: OffboardingService) {}

  @Get()
  findAll(
    @Query() query: ListOffboardingQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.offboardingService.findAll(query, caller.organizationId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.offboardingService.findOne(id, caller.organizationId);
  }

  @Post()
  initiate(@Body() dto: InitiateOffboardingDto, @CurrentUser() caller: Caller) {
    return this.offboardingService.initiate(dto, caller, caller.organizationId);
  }

  @Patch(':id/checklist')
  updateChecklist(
    @Param('id') id: string,
    @Body() dto: UpdateChecklistDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.offboardingService.updateChecklist(
      id,
      dto,
      caller.organizationId,
    );
  }

  @Patch(':id/exit-interview')
  submitExitInterview(
    @Param('id') id: string,
    @Body() dto: SubmitExitInterviewDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.offboardingService.submitExitInterview(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Patch(':id/settlement')
  linkSettlement(
    @Param('id') id: string,
    @Body() dto: LinkSettlementDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.offboardingService.linkSettlement(
      id,
      dto,
      caller.organizationId,
    );
  }

  @Patch(':id/complete')
  complete(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.offboardingService.complete(id, caller, caller.organizationId);
  }

  @Patch(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.offboardingService.cancel(id, caller.organizationId);
  }
}
