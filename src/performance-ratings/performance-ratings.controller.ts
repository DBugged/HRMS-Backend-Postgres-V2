// Purpose: Exposes endpoints to list and upsert employee performance ratings.
// Responsibilities: Validates DTOs and delegates all logic to PerformanceRatingsService.
// Important: Entire controller is gated to ADMIN/HR/MANAGER; MANAGER scoping (e.g. own department) is enforced in the service.
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
import { PerformanceRatingsService } from './performance-ratings.service';
import { UpsertPerformanceRatingDto } from './dto/upsert-performance-rating.dto';
import { QueryPerformanceRatingDto } from './dto/query-performance-rating.dto';
import { ApprovePerformanceRatingDto } from './dto/approve-performance-rating.dto';
import { RejectPerformanceRatingDto } from './dto/reject-performance-rating.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('performance-ratings')
@ApiBearerAuth('access-token')
@Roles(Role.ADMIN, Role.HR, Role.MANAGER)
@UseGuards(RolesGuard)
@Controller('performance-ratings')
export class PerformanceRatingsController {
  constructor(
    private readonly performanceRatingsService: PerformanceRatingsService,
  ) {}

  @Get()
  findAll(
    @Query() query: QueryPerformanceRatingDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.performanceRatingsService.findAll(
      query,
      caller,
      caller.organizationId,
    );
  }

  @Post()
  upsert(
    @Body() dto: UpsertPerformanceRatingDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.performanceRatingsService.upsert(
      dto,
      caller,
      caller.organizationId,
    );
  }

  // Only ADMIN/HR approve/reject a manager-submitted rating — not MANAGER,
  // who is the one submitting it.
  @Patch(':id/approve')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  approve(
    @Param('id') id: string,
    @Body() dto: ApprovePerformanceRatingDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.performanceRatingsService.approve(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Patch(':id/reject')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  reject(
    @Param('id') id: string,
    @Body() dto: RejectPerformanceRatingDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.performanceRatingsService.reject(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }
}
