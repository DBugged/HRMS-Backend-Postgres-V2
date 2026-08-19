import { Module } from '@nestjs/common';
import { TaxDeclarationsController } from './tax-declarations.controller';
import { TaxDeclarationsService } from './tax-declarations.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [TaxDeclarationsController],
  providers: [TaxDeclarationsService],
})
export class TaxDeclarationsModule {}
