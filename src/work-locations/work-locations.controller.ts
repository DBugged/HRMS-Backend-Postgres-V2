// Purpose: Exposes CRUD for geofenced work locations plus a lat/long point-in-geofence check.
// Responsibilities: Validates DTOs and delegates all logic to WorkLocationsService.
// Important: Reads have no @Roles() — needed for punch-in UI regardless of caller role; writes are ADMIN/HR only.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { WorkLocationsService } from './work-locations.service';
import { CreateWorkLocationDto } from './dto/create-work-location.dto';
import { UpdateWorkLocationDto } from './dto/update-work-location.dto';
import { ListWorkLocationsQueryDto } from './dto/list-work-locations-query.dto';
import { CheckPointDto } from './dto/check-point.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('work-locations')
@ApiBearerAuth('access-token')
@Controller('work-locations')
export class WorkLocationsController {
  constructor(private readonly workLocationsService: WorkLocationsService) {}

  // No @Roles() — any authenticated caller (needed for punch-in UI regardless
  // of the caller's own role, same as Departments).
  @Get()
  findAll(
    @Query() query: ListWorkLocationsQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.workLocationsService.findAll(query, caller.organizationId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.workLocationsService.findOne(id, caller.organizationId);
  }

  @Get(':id/check')
  checkPoint(
    @Param('id') id: string,
    @Query() query: CheckPointDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.workLocationsService.checkPoint(
      id,
      query.latitude,
      query.longitude,
      caller.organizationId,
    );
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateWorkLocationDto, @CurrentUser() caller: Caller) {
    return this.workLocationsService.create(
      dto,
      caller.id,
      caller.organizationId,
    );
  }

  @Put(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWorkLocationDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.workLocationsService.update(id, dto, caller.organizationId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.workLocationsService.remove(id, caller.organizationId);
  }
}
