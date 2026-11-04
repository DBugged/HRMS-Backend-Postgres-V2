// Purpose: Endpoints for client visits of field employees. Managers / HR plan and read; the employee checks in and out.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Role, User } from '@prisma/client';
import { FieldVisitsService } from './field-visits.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

class VisitDto {
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsString() @MaxLength(120) clientName?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsNumber() latitude?: number | null;
  @IsOptional() @IsNumber() longitude?: number | null;
  @IsOptional() @IsInt() @Min(50) @Max(1000) radiusMeters?: number;
  @IsOptional() @IsString() @MaxLength(500) purpose?: string;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'scheduledFor must be YYYY-MM-DD.',
  })
  scheduledFor?: string;
}

class CheckInDto {
  @IsNumber() latitude!: number;
  @IsNumber() longitude!: number;
  @IsOptional() @IsNumber() accuracyMeters?: number;
}

class CheckOutDto {
  @IsOptional() @IsNumber() latitude?: number;
  @IsOptional() @IsNumber() longitude?: number;
  @IsOptional() @IsString() @MaxLength(1000) outcome?: string;
}

@ApiTags('field-visits')
@ApiBearerAuth('access-token')
@Controller('field-visits')
export class FieldVisitsController {
  constructor(private readonly visits: FieldVisitsService) {}

  // The caller's own day (any role).
  @Get('mine')
  mine(@Query('date') date: string | undefined, @CurrentUser() caller: Caller) {
    return this.visits.mine(caller, date);
  }

  @Get('report')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  report(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.visits.report(caller, { from, to });
  }

  // Managers / HR: visits of the people they look after; an employee: their own.
  @Get()
  list(
    @Query()
    q: { from?: string; to?: string; employeeId?: string; status?: string },
    @CurrentUser() caller: Caller,
  ) {
    return this.visits.list(caller, q);
  }

  // Plan a visit: a manager / HR for someone they look after, or an employee for themselves.
  @Post()
  create(@Body() dto: VisitDto, @CurrentUser() caller: Caller) {
    return this.visits.create(caller, dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: VisitDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.visits.update(caller, id, dto);
  }

  @Delete(':id')
  cancel(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.visits.cancel(caller, id);
  }

  @Post(':id/check-in')
  checkIn(
    @Param('id') id: string,
    @Body() dto: CheckInDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.visits.checkIn(caller, id, dto);
  }

  @Post(':id/check-out')
  checkOut(
    @Param('id') id: string,
    @Body() dto: CheckOutDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.visits.checkOut(caller, id, dto);
  }
}
