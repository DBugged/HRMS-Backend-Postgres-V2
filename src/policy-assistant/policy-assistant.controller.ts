import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { PolicyAssistantService } from './policy-assistant.service';
import { AskPolicyAssistantDto } from './dto/ask-policy-assistant.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';

type Caller = Omit<User, 'password'>;

@ApiTags('policy-assistant')
@ApiBearerAuth('access-token')
@Controller('policy-assistant')
export class PolicyAssistantController {
  constructor(private readonly policyAssistantService: PolicyAssistantService) {}

  // No @Roles() — any authenticated employee can ask; the underlying policy
  // lookup is itself visibility-scoped (DocumentsService.findActivePoliciesRaw),
  // so nobody is ever answered from a document they couldn't otherwise see.
  @Post('ask')
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  ask(@Body() dto: AskPolicyAssistantDto, @CurrentUser() caller: Caller) {
    return this.policyAssistantService.ask(
      dto.question,
      caller,
      caller.organizationId,
    );
  }
}
