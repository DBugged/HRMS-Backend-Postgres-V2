import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssetDocType } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

// The frontend uploads through the shared POST /files/upload/documents
// endpoint first and posts the resulting {relativeKey, fileName} here —
// this module has no upload pipeline of its own, same as EmployeeDocument.
export class CreateAssetDocumentDto {
  @ApiProperty({ enum: AssetDocType })
  @IsEnum(AssetDocType)
  docType!: AssetDocType;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  fileName!: string;

  @ApiProperty({ description: 'relativeKey from POST /files/upload/documents' })
  @IsNotEmpty()
  @IsString()
  relativeKey!: string;

  // Set when this is a service report belonging to one maintenance visit.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  maintenanceId?: string;
}
