import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { Throttle } from '@nestjs/throttler';
import { AskHrService } from './ask-hr.service';
import { AskHrQueryDto } from './dto/ask-hr-query.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';

type Caller = Omit<User, 'password'>;

@ApiTags('ask-hr')
@ApiBearerAuth('access-token')
@Controller('ask-hr')
export class AskHrController {
  constructor(private readonly askHr: AskHrService) {}

  // The example questions under the search box, limited to the modules this company has on.
  @Get('suggestions')
  suggestions(@CurrentUser() caller: Caller) {
    return this.askHr.suggestions(caller.organizationId);
  }

  // What people asked over the last 30 days and which questions found nothing - HR/Admin only.
  @Get('insights')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  insights(@CurrentUser() caller: Caller) {
    return this.askHr.insights(caller.organizationId);
  }

  // Open to every signed-in employee; each answer is limited to what that person may already see (see the service header).
  @Get()
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  ask(@Query() query: AskHrQueryDto, @CurrentUser() caller: Caller) {
    return this.askHr.ask(query.q, caller, caller.organizationId);
  }
}
