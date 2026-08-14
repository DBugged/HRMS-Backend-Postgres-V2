import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { PolicyDocType, PolicyVisibility } from '@prisma/client';

export class CreatePolicyDocumentDto {
  @ApiPropertyOptional({
    description:
      'Required unless replacesId is set (inherited from the previous version otherwise).',
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ default: 'General' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ enum: PolicyDocType, default: PolicyDocType.PDF })
  @IsOptional()
  @IsEnum(PolicyDocType)
  docType?: PolicyDocType;

  // A relativeKey returned by POST /files/upload/documents, or a raw
  // http(s):// URL when docType=URL.
  @ApiProperty()
  @IsString()
  fileUrl!: string;

  @ApiProperty()
  @IsString()
  fileName!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

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

  // Publishing a new version of an existing document rather than a brand
  // new one — chains via previousVersionId and retires the old row.
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  replacesId?: string;
}
