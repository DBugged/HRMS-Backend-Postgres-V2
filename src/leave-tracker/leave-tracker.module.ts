import { Module } from '@nestjs/common';
import { LeaveTrackerController } from './leave-tracker.controller';
import { LeaveTrackerService } from './leave-tracker.service';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { CompOffsModule } from '../comp-offs/comp-offs.module';

import { PrivacyModule } from '../privacy/privacy.module';

@Module({
  imports: [LeaveBalancesModule, CompOffsModule, PrivacyModule],
  controllers: [LeaveTrackerController],
  providers: [LeaveTrackerService],
})
export class LeaveTrackerModule {}
