import { Module } from '@nestjs/common';
import { PlatformInternalController } from './platform-internal.controller';
import { PlatformInternalService } from './platform-internal.service';

@Module({
  controllers: [PlatformInternalController],
  providers: [PlatformInternalService],
})
export class PlatformInternalModule {}
