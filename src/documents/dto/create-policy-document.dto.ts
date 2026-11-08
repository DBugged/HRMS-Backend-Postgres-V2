import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, IsUUID, IsDateString, MaxLength } from 'class-validator';
import { PolicyDocType, PolicyVisibility } from '@prisma/client';

export class CreatePolicyDocumentDto {
  @ApiPropertyOptional({
    description:
      'Required unless replacesId is set (inherited from the previous version otherwise).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ default: 'General' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ enum: PolicyDocType, default: PolicyDocType.PDF })
  @IsOptional()
  @IsEnum(PolicyDocType)
  docType?: PolicyDocType;

  // A relativeKey returned by POST /files/upload/documents, or a raw
  // http(s):// URL when docType=URL.
  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  fileUrl!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Whether employees must e-acknowledge this document. Inherited from the previous version when replacesId is set.',
  })
  @IsOptional()
  @IsBoolean()
  requiresAcknowledgment?: boolean;

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

  @ApiPropertyOptional({ description: 'Text for Ask HR to search - for a link, an image or a scanned PDF. A stored PDF is read automatically.' })
  @IsOptional()
  @IsString()
  @MaxLength(200000)
  contentText?: string;

  // Publishing a new version of an existing document rather than a brand
  // new one — chains via previousVersionId and retires the old row.
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  replacesId?: string;
}
