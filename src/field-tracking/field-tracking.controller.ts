// Purpose: Endpoints for live tracking of field employees. Admin / HR choose who is tracked; the employee's phone sends
//   samples; managers, HR and Admin read the live view; anyone reads their own status and trail.
import {
  Body,
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
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsUUID,
} from 'class-validator';
import { Role, User } from '@prisma/client';
import { FieldTrackingService } from './field-tracking.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RawPing } from './field-tracking-logic';

type Caller = Omit<User, 'password'>;

class AssignTrackingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  employeeIds!: string[];

  @IsBoolean()
  enabled!: boolean;
}

class PingsDto {
  // Each point is validated one by one by the service (a bad one is refused, the rest are kept).
  @IsArray()
  pings!: RawPing[];
}

@ApiTags('field-tracking')
@ApiBearerAuth('access-token')
@Controller('field-tracking')
export class FieldTrackingController {
  constructor(private readonly tracking: FieldTrackingService) {}

  // No @Roles(): the caller's own tracking status (the apps use it to decide whether to ask for consent / start sampling).
  @Get('status')
  status(@CurrentUser() caller: Caller) {
    return this.tracking.status(caller);
  }

  @Post('consent')
  consent(@CurrentUser() caller: Caller) {
    return this.tracking.consent(caller);
  }

  @Post('pings')
  pings(@Body() dto: PingsDto, @CurrentUser() caller: Caller) {
    return this.tracking.ingest(caller, dto.pings);
  }

  // The caller's own day (any role).
  @Get('mine/route')
  mine(@Query('date') date: string | undefined, @CurrentUser() caller: Caller) {
    return this.tracking.route(caller, caller.id, date);
  }

  // The company's tracking settings: anyone may read them (the apps need the interval); Admin / HR change them.
  @Get('settings')
  settings(@CurrentUser() caller: Caller) {
    return this.tracking.getSettings(caller.organizationId);
  }

  @Put('settings')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateSettings(@Body() body: unknown, @CurrentUser() caller: Caller) {
    return this.tracking.updateSettings(caller, body);
  }

  // Head-counts for the dashboard tile (no names or places, so no audit entry).
  @Get('summary')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  summary(@CurrentUser() caller: Caller) {
    return this.tracking.summary(caller);
  }

  @Get('live')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  live(@CurrentUser() caller: Caller) {
    return this.tracking.live(caller);
  }

  // Admin / HR: choose who is tracked.
  @Patch('assign')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  assign(@Body() dto: AssignTrackingDto, @CurrentUser() caller: Caller) {
    return this.tracking.setEnabled(caller, dto.employeeIds, dto.enabled);
  }

  @Get('route/:employeeId')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  route(
    @Param('employeeId') employeeId: string,
    @Query('date') date: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.tracking.route(caller, employeeId, date);
  }
}
