import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, IsUUID, IsDateString, MaxLength } from 'class-validator';
import { PolicyVisibility } from '@prisma/client';

// Metadata-only edit — never touches the file itself. Also used for the
// publish/unpublish toggle ({ isPublished }).
export class UpdatePolicyDocumentDto {
  @ApiPropertyOptional({ description: 'Text for Ask HR to search. Empty clears it; a stored PDF is then read again on the next search.' })
  @IsOptional()
  @IsString()
  @MaxLength(200000)
  contentText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ enum: PolicyVisibility })
  @IsOptional()
  @IsEnum(PolicyVisibility)
  visibility?: PolicyVisibility;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  visibleDepartments?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  visibleEmployees?: string[];

  // YYYY-MM-DD; null clears it.
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  reviewDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresAcknowledgment?: boolean;
}
