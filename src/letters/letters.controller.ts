// Purpose: Exposes letter generation as a PDF download, mounted at /employees/:id/letters/:key — key is a
//   LetterTemplate's key (see letter-templates module), not a fixed set: any active template, built-in or
//   admin-created custom, is downloadable here.
// Important: Self-or-role scoped (self, or ADMIN/HR/MANAGER — MANAGER further restricted to own
//   department in the service), same pattern as /employees/:id/timeline.
import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import { LettersService } from './letters.service';
import { SelfOrRoles } from '../common/decorators/self-or-roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';

type Caller = Omit<User, 'password'>;

@ApiTags('letters')
@ApiBearerAuth('access-token')
@Controller('employees/:id/letters')
export class LettersController {
  constructor(private readonly lettersService: LettersService) {}

  @Get(':key')
  @SelfOrRoles('id', Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async generate(
    @Param('id') id: string,
    @Param('key') key: string,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.lettersService.generate(
      id,
      key,
      caller,
      caller.organizationId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(buffer);
  }
}
