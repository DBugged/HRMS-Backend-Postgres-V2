// Purpose: Exposes endpoints to claim, list, and review reimbursement requests.
// Responsibilities: Validates DTOs and delegates all logic to ReimbursementsService.
// Important: Only review is gated to ADMIN/HR; findAll/create have no @Roles() and self-scope for EMPLOYEE in the service.
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { ReimbursementsService } from './reimbursements.service';
import {
  CreateReimbursementBatchDto,
  CreateReimbursementDto,
} from './dto/create-reimbursement.dto';
import { ReviewReimbursementDto } from './dto/review-reimbursement.dto';
import { BulkReviewReimbursementDto } from './dto/bulk-review-reimbursement.dto';
import { ReimbursementFormQueryDto } from './dto/reimbursement-form-query.dto';
import { QueryReimbursementDto } from './dto/query-reimbursement.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('reimbursements')
@ApiBearerAuth('access-token')
@Controller('reimbursements')
export class ReimbursementsController {
  constructor(private readonly reimbursementsService: ReimbursementsService) {}

  // The month's claims as the company's Expense Reimbursement Form (Excel). Anyone gets their own; Admin/HR can name
  // employees or take every employee with claims. Declared before the other GET routes.
  @Get('form')
  async monthlyForm(
    @Query() query: ReimbursementFormQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.reimbursementsService.monthlyForm(query, caller, caller.organizationId);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  }

  // No @Roles() — any authenticated caller (self-scoped for EMPLOYEE,
  // service-side).
  @Get()
  findAll(
    @Query() query: QueryReimbursementDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.reimbursementsService.findAll(
      query,
      caller,
      caller.organizationId,
    );
  }

  // No @Roles() — any authenticated caller claims for themselves only.
  @Post()
  create(@Body() dto: CreateReimbursementDto, @CurrentUser() caller: Caller) {
    return this.reimbursementsService.create(
      dto,
      caller,
      caller.organizationId,
    );
  }

  // One category and receipt on several dates: creates one claim per date, all or nothing.
  @Post('batch')
  createMany(
    @Body() dto: CreateReimbursementBatchDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.reimbursementsService.createMany(
      dto,
      caller,
      caller.organizationId,
    );
  }

  // The original release's PAYROLL_CONFIG_ROLES (hr_admin, payroll_manager,
  // administrator) collapses to [ADMIN, HR], same convention used
  // throughout Payroll.
  @Patch(':id/review')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  review(
    @Param('id') id: string,
    @Body() dto: ReviewReimbursementDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.reimbursementsService.review(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Patch('bulk-review')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  bulkReview(
    @Body() dto: BulkReviewReimbursementDto,
    @CurrentUser() caller: Caller,
  ) {
    const { ids, ...rest } = dto;
    return this.reimbursementsService.bulkReview(
      ids,
      rest,
      caller,
      caller.organizationId,
    );
  }
}
