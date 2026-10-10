// Purpose: Exposes endpoints for viewing and setting an employee's salary component structure and history.
// Responsibilities: Validates DTOs and delegates all logic to EmployeeSalaryComponentsService.
// Important: getStructure uses @SelfOrRoles so an employee can view their own structure; writes are ADMIN/HR only.
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ForbiddenException } from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { EmployeeSalaryComponentsService } from './employee-salary-components.service';
import { SetComponentValueDto } from './dto/set-component-value.dto';
import { BulkSetStructureDto } from './dto/bulk-set-structure.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { SelfOrRoles } from '../common/decorators/self-or-roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

// Nobody - HR or Admin - sets or revises their OWN salary structure; it has to be done by someone else. An Admin can
// still calculate and approve payroll for everyone, including themself: the structure is the part that must be
// changed by a second person, otherwise one account could raise its own pay and then pay it.
function assertNotOwnSalary(caller: Caller, employeeId: string): void {
  if (caller.id === employeeId) {
    throw new ForbiddenException(
      'You cannot change your own salary structure. Another HR user or Admin must do it.',
    );
  }
}

@ApiTags('employee-salary')
@ApiBearerAuth('access-token')
@Controller('employee-salary')
export class EmployeeSalaryComponentsController {
  constructor(
    private readonly employeeSalaryComponentsService: EmployeeSalaryComponentsService,
  ) {}

  @Get(':id/structure')
  @SelfOrRoles('id', Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  getStructure(
    @Param('id') id: string,
    @Query('asOf') asOf: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeSalaryComponentsService.getStructure(
      id,
      asOf,
      caller.organizationId,
    );
  }

  @Get(':id/history')
  @SelfOrRoles('id', Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  getHistory(
    @Param('id') id: string,
    @Query('componentCode') componentCode: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeSalaryComponentsService.getHistory(
      id,
      componentCode,
      caller.organizationId,
    );
  }

  @Post(':id/structure')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  setComponentValue(
    @Param('id') id: string,
    @Body() dto: SetComponentValueDto,
    @CurrentUser() caller: Caller,
  ) {
    assertNotOwnSalary(caller, id);
    return this.employeeSalaryComponentsService.setComponentValue(
      id,
      dto,
      caller.id,
      caller.organizationId,
    );
  }

  @Post(':id/structure/bulk')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  bulkSetStructure(
    @Param('id') id: string,
    @Body() dto: BulkSetStructureDto,
    @CurrentUser() caller: Caller,
  ) {
    assertNotOwnSalary(caller, id);
    return this.employeeSalaryComponentsService.bulkSetStructure(
      id,
      dto,
      caller.id,
      caller.organizationId,
    );
  }
}
