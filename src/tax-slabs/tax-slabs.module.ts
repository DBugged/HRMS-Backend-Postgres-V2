import { Module } from '@nestjs/common';
import { TaxSlabsController } from './tax-slabs.controller';
import { TaxSlabsService } from './tax-slabs.service';

@Module({
  controllers: [TaxSlabsController],
  providers: [TaxSlabsService],
})
export class TaxSlabsModule {}
