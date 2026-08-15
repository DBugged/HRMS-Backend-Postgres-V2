import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import type { Response } from 'express';
import { PayrollTemplatesService } from './payroll-templates.service';
import { CreatePayrollTemplateDto } from './dto/create-payroll-template.dto';
import { UpdatePayrollTemplateDto } from './dto/update-payroll-template.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('payroll-templates')
@ApiBearerAuth('access-token')
@Controller('payroll-templates')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class PayrollTemplatesController {
  constructor(
    private readonly payrollTemplatesService: PayrollTemplatesService,
  ) {}

  @Get()
  findAll(@CurrentUser() caller: Caller) {
    return this.payrollTemplatesService.findAll(caller.organizationId);
  }

  // Registered ahead of the GET/POST :id routes so 'draft' is never
  // swallowed as a param value.
  @Post('draft/preview')
  @Header('Content-Type', 'application/pdf')
  @Header(
    'Content-Disposition',
    'inline; filename=payslip-template-preview.pdf',
  )
  async previewDraft(
    @Body() dto: CreatePayrollTemplateDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const buffer = await this.payrollTemplatesService.previewDraft(
      dto,
      caller.organizationId,
    );
    res.send(buffer);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollTemplatesService.findOne(id, caller.organizationId);
  }

  @Post()
  create(@Body() dto: CreatePayrollTemplateDto, @CurrentUser() caller: Caller) {
    return this.payrollTemplatesService.create(
      dto,
      caller.id,
      caller.organizationId,
    );
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePayrollTemplateDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollTemplatesService.update(id, dto, caller.organizationId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollTemplatesService.remove(id, caller.organizationId);
  }

  @Post(':id/set-default')
  setDefault(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollTemplatesService.setDefault(id, caller.organizationId);
  }

  @Post(':id/preview')
  @Header('Content-Type', 'application/pdf')
  @Header(
    'Content-Disposition',
    'inline; filename=payslip-template-preview.pdf',
  )
  async previewSaved(
    @Param('id') id: string,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const buffer = await this.payrollTemplatesService.previewSaved(
      id,
      caller.organizationId,
    );
    res.send(buffer);
  }
}
