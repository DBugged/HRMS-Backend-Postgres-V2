import { Module } from '@nestjs/common';
import { OvertimeController } from './overtime.controller';
import { OvertimeService } from './overtime.service';

@Module({
  controllers: [OvertimeController],
  providers: [OvertimeService],
  exports: [OvertimeService],
})
export class OvertimeModule {}
