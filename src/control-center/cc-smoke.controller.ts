// Purpose: POST /api/v1/smoke-test - runs the Super Admin's smoke test (see cc-smoke.service.ts).
// Important: Control Panel OWNER only ('smoke-test:run' is held by no other role). The caller's own panel token is forwarded to the
//   panel checks, so they run with the caller's rights and nobody is impersonated.
import { Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CcAuthGuard } from './cc-auth.guard';
import { CcPermission, CcPermissionGuard } from './cc-permission.guard';
import { CcSmokeService } from './cc-smoke.service';

@ApiTags('control-center')
@Public()
@UseGuards(CcAuthGuard, CcPermissionGuard)
@Controller('api/v1')
export class CcSmokeController {
  constructor(private readonly svc: CcSmokeService) {}

  @Post('smoke-test')
  @CcPermission('smoke-test:run')
  run(@Headers('authorization') authorization?: string) {
    return this.svc.run(authorization);
  }
}
