import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AccessControlController } from './access-control.controller';
import { AccessControlService } from './access-control.service';

@Module({
  imports: [DiscoveryModule],
  controllers: [AccessControlController],
  providers: [AccessControlService],
})
export class AccessControlModule {}
