import { Module } from '@nestjs/common';
import { OvertimeController } from './overtime.controller';
import { OvertimeService } from './overtime.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [OvertimeController],
  providers: [OvertimeService],
  exports: [OvertimeService],
})
export class OvertimeModule {}
