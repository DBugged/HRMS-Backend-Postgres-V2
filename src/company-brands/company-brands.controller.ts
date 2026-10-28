// Purpose: the company brands API - the sister-company names, logos and employee ID series under Organization.
// Important: ADMIN and HR may read the list (HR picks a company on the employee form); only an ADMIN may add, change or delete one.
import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyBrandsService } from './company-brands.service';
import { CreateCompanyBrandDto } from './dto/create-company-brand.dto';
import { UpdateCompanyBrandDto } from './dto/update-company-brand.dto';

type Caller = Omit<User, 'password'>;

@ApiTags('company-brands')
@ApiBearerAuth('access-token')
@Controller('company-brands')
@UseGuards(RolesGuard)
export class CompanyBrandsController {
  constructor(private readonly service: CompanyBrandsService) {}

  @Get()
  @Roles(Role.ADMIN, Role.HR)
  list(@CurrentUser() caller: Caller) {
    return this.service.list(caller.organizationId);
  }

  @Post()
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateCompanyBrandDto, @CurrentUser() caller: Caller) {
    return this.service.create(dto, caller, caller.organizationId);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateCompanyBrandDto, @CurrentUser() caller: Caller) {
    return this.service.update(id, dto, caller, caller.organizationId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.service.remove(id, caller, caller.organizationId);
  }
}
