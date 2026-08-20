// Purpose: Exposes CRUD for salary component definitions, plus reordering and formula validation.
// Responsibilities: Validates DTOs and delegates all logic to SalaryComponentsService.
// Important: Entire controller is gated to ADMIN/HR; validate-formula is registered before ':id' so it isn't swallowed as a param.
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
import { SalaryComponentsService } from './salary-components.service';
import { CreateSalaryComponentDto } from './dto/create-salary-component.dto';
import { UpdateSalaryComponentDto } from './dto/update-salary-component.dto';
import { ReorderSalaryComponentsDto } from './dto/reorder-salary-components.dto';
import { ValidateFormulaDto } from './dto/validate-formula.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('salary-components')
@ApiBearerAuth('access-token')
@Controller('salary-components')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class SalaryComponentsController {
  constructor(
    private readonly salaryComponentsService: SalaryComponentsService,
  ) {}

  @Get()
  findAll(@CurrentUser() caller: Caller) {
    return this.salaryComponentsService.findAll(caller.organizationId);
  }

  // Registered before ':id' — same reasoning as Holidays' bulk-import.
  @Post('validate-formula')
  validateFormula(
    @Body() dto: ValidateFormulaDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.salaryComponentsService.validateFormula(
      dto,
      caller.organizationId,
    );
  }

  @Post()
  create(@Body() dto: CreateSalaryComponentDto, @CurrentUser() caller: Caller) {
    return this.salaryComponentsService.create(
      dto,
      caller.id,
      caller.organizationId,
    );
  }

  @Patch('reorder')
  reorder(
    @Body() dto: ReorderSalaryComponentsDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.salaryComponentsService.reorder(dto, caller.organizationId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSalaryComponentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.salaryComponentsService.update(id, dto, caller.organizationId);
  }

  @Patch(':id/toggle')
  toggle(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.salaryComponentsService.toggle(id, caller.organizationId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.salaryComponentsService.remove(id, caller.organizationId);
  }
}
