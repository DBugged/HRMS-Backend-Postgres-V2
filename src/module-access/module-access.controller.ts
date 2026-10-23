// Purpose: GET /modules - tells the web and mobile apps which modules are switched off for the signed-in user's company,
// so they can hide those menus instead of showing screens that would be refused.
import { Controller, Get, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import { ModuleAccessService } from './module-access.service';

@ApiTags('modules')
@Controller('modules')
export class ModuleAccessController {
  constructor(private readonly access: ModuleAccessService) {}

  @Get()
  async modules(@Req() req: Request) {
    const user = req.user as User;
    return { disabled: [...(await this.access.disabledFor(user.organizationId))] };
  }
}
