import { Module } from '@nestjs/common';
import { LetterTemplatesController } from './letter-templates.controller';
import { LetterTemplatesService } from './letter-templates.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [LetterTemplatesController],
  providers: [LetterTemplatesService],
  exports: [LetterTemplatesService],
})
export class LetterTemplatesModule {}
