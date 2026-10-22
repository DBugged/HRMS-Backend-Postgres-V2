// Purpose: HTTP for a company's own profile fields: GET /custom-fields (the definitions - any signed-in user, the forms
//   need them), POST/PATCH /custom-fields (Admin/HR), and PATCH /employees/:id/custom-fields (an employee's values:
//   HR/Admin for anyone, the employee for themself - the service limits them to the fields marked editable).
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { CustomFieldsService } from './custom-fields.service';
import {
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
  UpdateCustomFieldValuesDto,
} from './dto/custom-field.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { SelfOrRoles } from '../common/decorators/self-or-roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

class ListCustomFieldsQuery {
  // Admin/HR only: include the fields that are switched off.
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

@ApiTags('custom-fields')
@ApiBearerAuth('access-token')
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly service: CustomFieldsService) {}

  @Get()
  list(@Query() q: ListCustomFieldsQuery, @CurrentUser() caller: Caller) {
    return this.service.list(caller.organizationId, caller, q.includeInactive ?? false);
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateCustomFieldDto, @CurrentUser() caller: Caller) {
    return this.service.create(dto, caller, caller.organizationId);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(@Param('id') id: string, @Body() dto: UpdateCustomFieldDto, @CurrentUser() caller: Caller) {
    return this.service.update(id, dto, caller, caller.organizationId);
  }
}

@ApiTags('custom-fields')
@ApiBearerAuth('access-token')
@Controller('employees/:id/custom-fields')
export class EmployeeCustomFieldsController {
  constructor(private readonly service: CustomFieldsService) {}

  @Patch()
  @SelfOrRoles('id', Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateValues(@Param('id') id: string, @Body() dto: UpdateCustomFieldValuesDto, @CurrentUser() caller: Caller) {
    return this.service.updateValues(id, dto, caller, caller.organizationId);
  }
}
