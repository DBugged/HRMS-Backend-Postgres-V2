import { Module } from '@nestjs/common';
import { LeaveTypesController } from './leave-types.controller';
import { LeaveTypesService } from './leave-types.service';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';

@Module({
  imports: [LeaveBalancesModule],
  controllers: [LeaveTypesController],
  providers: [LeaveTypesService],
})
export class LeaveTypesModule {}
