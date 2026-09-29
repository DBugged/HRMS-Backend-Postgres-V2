import { Module } from '@nestjs/common';
import { PlatformInternalController } from './platform-internal.controller';
import { PlatformInternalService } from './platform-internal.service';
import { ControlCenterClient } from './control-center.client';

@Module({
  controllers: [PlatformInternalController],
  providers: [PlatformInternalService, ControlCenterClient],
  exports: [ControlCenterClient],
})
export class PlatformInternalModule {}
