// Purpose: Exposes the resignation workflow — employee submit/withdraw/list-own, HR/Admin list/get/approve/reject.
// Responsibilities: Validates DTOs and delegates to ResignationsService.
// Important: Employee routes (submit, mine, withdraw) have no @Roles() and are self-scoped in the service; the
// list/approve/reject routes are [ADMIN, HR]. GET :id is self-or-HR/Admin, checked in the service.
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
import { ResignationsService } from './resignations.service';
import { SubmitResignationDto } from './dto/submit-resignation.dto';
import {
  ApproveResignationDto,
  RejectResignationDto,
} from './dto/decide-resignation.dto';
import { ListResignationsQueryDto } from './dto/list-resignations-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('resignations')
@ApiBearerAuth('access-token')
@Controller('resignations')
export class ResignationsController {
  constructor(private readonly resignationsService: ResignationsService) {}

  @Post()
  submit(@Body() dto: SubmitResignationDto, @CurrentUser() caller: Caller) {
    return this.resignationsService.submit(dto, caller);
  }

  @Get('mine')
  findMine(@CurrentUser() caller: Caller) {
    return this.resignationsService.findMine(caller);
  }

  @Get()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  findAll(
    @Query() query: ListResignationsQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.resignationsService.findAll(query, caller.organizationId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.resignationsService.findOne(id, caller);
  }

  @Patch(':id/withdraw')
  withdraw(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.resignationsService.withdraw(id, caller);
  }

  @Patch(':id/approve')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveResignationDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.resignationsService.approve(id, dto, caller);
  }

  @Patch(':id/reject')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  reject(
    @Param('id') id: string,
    @Body() dto: RejectResignationDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.resignationsService.reject(id, dto, caller);
  }
}
