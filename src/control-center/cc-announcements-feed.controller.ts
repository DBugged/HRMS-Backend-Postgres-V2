// Purpose: GET /platform-announcements - the announcements a Super Admin published, as seen by a company's own users.
// Important: this is an HRMS route (normal customer sign-in, NOT @Public() and NOT the Control Center token); it only ever
//   returns announcements that target this user's company, so one customer never sees another's.
import { Controller, Get, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import { CcSupportService } from './cc-support.service';

@ApiTags('platform-announcements')
@Controller('platform-announcements')
export class CcAnnouncementsFeedController {
  constructor(private readonly support: CcSupportService) {}

  @Get()
  live(@Req() req: Request) {
    return this.support.liveFor((req.user as User).organizationId);
  }
}
