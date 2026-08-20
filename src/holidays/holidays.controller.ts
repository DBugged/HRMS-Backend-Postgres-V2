// Purpose: Exposes CRUD for the organization's holiday calendar, plus bulk import.
// Responsibilities: Validates DTOs and delegates all logic to HolidaysService.
// Important: findAll has no @Roles() — any authenticated caller can view the calendar; writes are ADMIN/HR only.
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
import { HolidaysService } from './holidays.service';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { ListHolidaysQueryDto } from './dto/list-holidays-query.dto';
import { BulkImportHolidaysDto } from './dto/bulk-import-holidays.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('holidays')
@ApiBearerAuth('access-token')
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly holidaysService: HolidaysService) {}

  // No @Roles() — any authenticated caller can view the holiday calendar.
  @Get()
  findAll(@Query() query: ListHolidaysQueryDto, @CurrentUser() caller: Caller) {
    return this.holidaysService.findAll(query, caller.organizationId);
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateHolidayDto, @CurrentUser() caller: Caller) {
    return this.holidaysService.create(dto, caller.organizationId);
  }

  @Post('bulk-import')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  bulkImport(
    @Body() dto: BulkImportHolidaysDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.holidaysService.bulkImport(dto, caller.organizationId);
  }

  @Put(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateHolidayDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.holidaysService.update(id, dto, caller.organizationId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.holidaysService.remove(id, caller.organizationId);
  }
}
