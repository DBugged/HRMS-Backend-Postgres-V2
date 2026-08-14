import { Module } from '@nestjs/common';
import { ReimbursementsController } from './reimbursements.controller';
import { ReimbursementsService } from './reimbursements.service';

@Module({
  controllers: [ReimbursementsController],
  providers: [ReimbursementsService],
})
export class ReimbursementsModule {}
