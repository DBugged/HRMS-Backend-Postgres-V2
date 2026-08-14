import { Module } from '@nestjs/common';
import { StatutoryConfigController } from './statutory-config.controller';
import { StatutoryConfigService } from './statutory-config.service';

@Module({
  controllers: [StatutoryConfigController],
  providers: [StatutoryConfigService],
  exports: [StatutoryConfigService],
})
export class StatutoryConfigModule {}
