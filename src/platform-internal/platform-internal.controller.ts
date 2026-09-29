import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsString, MinLength } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { PlatformS2sGuard } from '../common/guards/platform-s2s.guard';
import { PlatformInternalService } from './platform-internal.service';

class SetOrgStatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED', 'ARCHIVED', 'PENDING'])
  status!: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' | 'PENDING';

  @IsString()
  @MinLength(1)
  reason!: string;
}

// Platform-level S2S surface for the HRMS Control Center (separate service,
// separate DB, separate Super Admin auth — see docs in that repo). Every
// route here is @Public() + PlatformS2sGuard: no org's own JWT/session can
// ever reach these, by construction, not by a role check.
@Controller('internal')
@UseGuards(PlatformS2sGuard)
export class PlatformInternalController {
  constructor(private readonly service: PlatformInternalService) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Public()
  @Get('orgs/:id')
  getOrg(@Param('id') id: string) {
    return this.service.getOrg(id);
  }

  @Public()
  @Patch('orgs/:id/status')
  @HttpCode(204)
  async setStatus(@Param('id') id: string, @Body() dto: SetOrgStatusDto) {
    await this.service.setOrgStatus(id, dto.status, dto.reason);
  }

  @Public()
  @Get('orgs/:id/usage')
  getUsage(@Param('id') id: string) {
    return this.service.getUsage(id);
  }
}
