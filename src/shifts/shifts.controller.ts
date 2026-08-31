// Purpose: Exposes CRUD for the standalone Shift reference catalog.
// Important: findAll has no @Roles() — any authenticated caller, same convention as Departments/
// OrgListItems/WorkSchedules; writes are ADMIN/HR.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { ShiftsService } from './shifts.service';
import { CreateShiftDto } from './dto/create-shift.dto';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('shifts')
@ApiBearerAuth('access-token')
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shiftsService: ShiftsService) {}

  @Get()
  findAll(@CurrentUser() caller: Caller) {
    return this.shiftsService.findAll(caller.organizationId);
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateShiftDto, @CurrentUser() caller: Caller) {
    return this.shiftsService.create(dto, caller.organizationId, caller);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateShiftDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.shiftsService.update(id, dto, caller.organizationId, caller);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.shiftsService.delete(id, caller.organizationId, caller);
  }
}
