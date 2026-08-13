import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('departments')
@ApiBearerAuth('access-token')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(
    @Body() dto: CreateDepartmentDto,
    @CurrentUser() caller: Omit<User, 'password'>,
  ) {
    return this.departmentsService.create(dto, caller.organizationId);
  }

  // No @Roles() — any authenticated caller (needed for dropdowns on the
  // create-employee form regardless of the caller's own role).
  @Get()
  findAll(@CurrentUser() caller: Omit<User, 'password'>) {
    return this.departmentsService.findAll(caller.organizationId);
  }
}
