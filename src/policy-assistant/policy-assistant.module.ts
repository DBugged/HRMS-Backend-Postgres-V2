import { Module } from '@nestjs/common';
import { PolicyAssistantController } from './policy-assistant.controller';
import { PolicyAssistantService } from './policy-assistant.service';
import { DocumentsModule } from '../documents/documents.module';

@Module({
  imports: [DocumentsModule],
  controllers: [PolicyAssistantController],
  providers: [PolicyAssistantService],
})
export class PolicyAssistantModule {}
