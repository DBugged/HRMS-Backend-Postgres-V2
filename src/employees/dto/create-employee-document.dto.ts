import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { EmployeeDocumentCategory } from '@prisma/client';

export class CreateEmployeeDocumentDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  docType!: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @MaxLength(1000)
  fileName!: string;

  // A relativeKey from POST /files/upload/documents.
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  fileUrl!: string;

  // DOCUMENT (default) for the Documents tab's KYC/onboarding paperwork;
  // LETTER for a manually-uploaded letter shown on the Letters tab instead.
  @ApiPropertyOptional({ enum: EmployeeDocumentCategory })
  @IsOptional()
  @IsEnum(EmployeeDocumentCategory)
  category?: EmployeeDocumentCategory;

}
