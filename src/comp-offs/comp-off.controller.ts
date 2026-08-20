// Purpose: Exposes endpoints to earn, list, and review compensatory-off (comp-off) requests and check balances.
// Responsibilities: Validates DTOs and delegates all logic to CompOffService.
// Important: Only review is gated to ADMIN/HR/MANAGER; other routes have no @Roles() and self-scope in the service.
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
import { CompOffService } from './comp-off.service';
import { CreateCompOffDto } from './dto/create-comp-off.dto';
import { ReviewCompOffDto } from './dto/review-comp-off.dto';
import { ListCompOffsQueryDto } from './dto/list-comp-offs-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('comp-offs')
@ApiBearerAuth('access-token')
@Controller('comp-offs')
export class CompOffController {
  constructor(private readonly compOffService: CompOffService) {}

  @Get()
  findAll(@Query() query: ListCompOffsQueryDto, @CurrentUser() caller: Caller) {
    return this.compOffService.findAll(query, caller, caller.organizationId);
  }

  @Get('balance')
  balance(
    @Query('employeeId') employeeId: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.compOffService.balance(
      employeeId,
      caller,
      caller.organizationId,
    );
  }

  @Post()
  earn(@Body() dto: CreateCompOffDto, @CurrentUser() caller: Caller) {
    return this.compOffService.earn(dto, caller, caller.organizationId);
  }

  @Patch(':id/review')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  review(
    @Param('id') id: string,
    @Body() dto: ReviewCompOffDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.compOffService.review(id, dto, caller, caller.organizationId);
  }
}
