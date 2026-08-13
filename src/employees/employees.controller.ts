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
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { ListEmployeesQueryDto } from './dto/list-employees-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { SelfOrRoles } from '../common/decorators/self-or-roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('employees')
@ApiBearerAuth('access-token')
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateEmployeeDto, @CurrentUser() caller: Caller) {
    return this.employeesService.create(dto, caller, caller.organizationId);
  }

  @Get()
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  findAll(
    @Query() query: ListEmployeesQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeesService.findAll(query, caller, caller.organizationId);
  }

  @Get(':id')
  @SelfOrRoles('id', Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  findOne(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.employeesService.findOne(id, caller, caller.organizationId);
  }

  @Patch(':id')
  @SelfOrRoles('id', Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeesService.update(id, dto, caller, caller.organizationId);
  }

  @Patch(':id/deactivate')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  deactivate(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.employeesService.deactivate(id, caller.organizationId);
  }
}
