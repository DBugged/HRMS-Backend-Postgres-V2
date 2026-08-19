import { Module } from '@nestjs/common';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [LoansController],
  providers: [LoansService],
})
export class LoansModule {}
