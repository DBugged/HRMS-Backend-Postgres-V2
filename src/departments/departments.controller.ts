// Purpose: Exposes CRUD for departments, plus assigning a department head and mapping employees to a department.
// Responsibilities: Validates DTOs and delegates all logic to DepartmentsService.
// Important: Only findAll (list) has no @Roles() — needed for dropdowns on other forms; all writes are ADMIN/HR.
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
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { AssignDepartmentHeadDto } from './dto/assign-department-head.dto';
import { MapEmployeesDto } from './dto/map-employees.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('departments')
@ApiBearerAuth('access-token')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateDepartmentDto, @CurrentUser() caller: Caller) {
    return this.departmentsService.create(dto, caller.organizationId);
  }

  // No @Roles() — any authenticated caller (needed for dropdowns on the
  // create-employee form regardless of the caller's own role).
  @Get()
  findAll(@CurrentUser() caller: Caller) {
    return this.departmentsService.findAll(caller.organizationId);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDepartmentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.departmentsService.update(id, dto, caller.organizationId);
  }

  @Post(':id/assign-head')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  assignHead(
    @Param('id') id: string,
    @Body() dto: AssignDepartmentHeadDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.departmentsService.assignHead(
      id,
      dto.userId,
      caller.organizationId,
    );
  }

  @Post(':id/map-employees')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  mapEmployees(
    @Param('id') id: string,
    @Body() dto: MapEmployeesDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.departmentsService.mapEmployees(id, dto, caller.organizationId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.departmentsService.remove(id, caller.organizationId);
  }
}
