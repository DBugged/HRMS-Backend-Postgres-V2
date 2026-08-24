import { Module } from '@nestjs/common';
import { ApprovalDelegationController } from './approval-delegation.controller';
import { ApprovalDelegationService } from './approval-delegation.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [ApprovalDelegationController],
  providers: [ApprovalDelegationService],
  exports: [ApprovalDelegationService],
})
export class ApprovalDelegationModule {}
