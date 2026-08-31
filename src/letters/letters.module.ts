import { Module } from '@nestjs/common';
import { LettersController } from './letters.controller';
import { LettersService } from './letters.service';
import { LetterPdfService } from './letter-pdf.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { LetterTemplatesModule } from '../letter-templates/letter-templates.module';

@Module({
  imports: [AuditLogModule, LetterTemplatesModule],
  controllers: [LettersController],
  providers: [LettersService, LetterPdfService],
})
export class LettersModule {}
