import { Module } from '@nestjs/common';
import { PerformanceRatingsController } from './performance-ratings.controller';
import { PerformanceRatingsService } from './performance-ratings.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [PerformanceRatingsController],
  providers: [PerformanceRatingsService],
  exports: [PerformanceRatingsService],
})
export class PerformanceRatingsModule {}
