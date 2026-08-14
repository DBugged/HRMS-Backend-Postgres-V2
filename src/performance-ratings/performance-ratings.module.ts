import { Module } from '@nestjs/common';
import { PerformanceRatingsController } from './performance-ratings.controller';
import { PerformanceRatingsService } from './performance-ratings.service';

@Module({
  controllers: [PerformanceRatingsController],
  providers: [PerformanceRatingsService],
  exports: [PerformanceRatingsService],
})
export class PerformanceRatingsModule {}
