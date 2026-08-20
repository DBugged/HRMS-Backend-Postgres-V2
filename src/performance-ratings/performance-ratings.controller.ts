// Purpose: Exposes endpoints to list and upsert employee performance ratings.
// Responsibilities: Validates DTOs and delegates all logic to PerformanceRatingsService.
// Important: Entire controller is gated to ADMIN/HR/MANAGER; MANAGER scoping (e.g. own department) is enforced in the service.
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { PerformanceRatingsService } from './performance-ratings.service';
import { UpsertPerformanceRatingDto } from './dto/upsert-performance-rating.dto';
import { QueryPerformanceRatingDto } from './dto/query-performance-rating.dto';
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
}
