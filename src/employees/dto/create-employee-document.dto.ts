import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
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

  // YYYY-MM-DD the document stops being valid; reminders go out before it. Leave out for a document that never expires.
  @ApiPropertyOptional({ example: '2030-05-31' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Expiry date must be YYYY-MM-DD.' })
  expiryDate?: string;
}
