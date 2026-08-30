import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsOptional, IsUUID } from 'class-validator';

export class SendEmailTemplateDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  employeeIds!: string[];

  // Optional CC list, distinct from ccAllActive (which always CCs every
  // active employee) — this lets the sender pick a handful of specific
  // people to CC on a manual send, same "to" vs "cc" split as a normal
  // email client. Any id also present in employeeIds is deduped out
  // server-side (see EmailTemplatesService.sendManual) rather than
  // rejected, since sending "to yourself and CC yourself" is a UI
  // detail, not a validation error.
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  ccEmployeeIds?: string[];
}
