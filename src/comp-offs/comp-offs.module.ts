import { Module } from '@nestjs/common';
import { CompOffController } from './comp-off.controller';
import { CompOffService } from './comp-off.service';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PayrollSettingsModule, NotificationsModule],
  controllers: [CompOffController],
  providers: [CompOffService],
  exports: [CompOffService],
})
export class CompOffsModule {}
