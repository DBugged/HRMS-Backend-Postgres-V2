import { Module } from '@nestjs/common';
import { AskHrController } from './ask-hr.controller';
import { AskHrService } from './ask-hr.service';
import { DocumentsModule } from '../documents/documents.module';
import { LettersModule } from '../letters/letters.module';

@Module({
  imports: [DocumentsModule, LettersModule],
  controllers: [AskHrController],
  providers: [AskHrService],
})
export class AskHrModule {}
