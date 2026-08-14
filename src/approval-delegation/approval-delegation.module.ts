import { Module } from '@nestjs/common';
import { ApprovalDelegationController } from './approval-delegation.controller';
import { ApprovalDelegationService } from './approval-delegation.service';

@Module({
  controllers: [ApprovalDelegationController],
  providers: [ApprovalDelegationService],
  exports: [ApprovalDelegationService],
})
export class ApprovalDelegationModule {}
