import { Module } from '@nestjs/common';
import { LettersController } from './letters.controller';
import { LettersService } from './letters.service';
import { LetterPdfService } from './letter-pdf.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [LettersController],
  providers: [LettersService, LetterPdfService],
})
export class LettersModule {}
