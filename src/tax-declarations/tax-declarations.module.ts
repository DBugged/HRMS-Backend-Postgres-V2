import { Module } from '@nestjs/common';
import { TaxDeclarationsController } from './tax-declarations.controller';
import { TaxDeclarationsService } from './tax-declarations.service';

@Module({
  controllers: [TaxDeclarationsController],
  providers: [TaxDeclarationsService],
})
export class TaxDeclarationsModule {}
