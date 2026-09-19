import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PrivacyRecordStatus } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateDataSharingDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) recipient!: string;
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  dataCategory!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  purpose?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  integration?: string;
  @ApiPropertyOptional({ enum: PrivacyRecordStatus })
  @IsOptional()
  @IsEnum(PrivacyRecordStatus)
  status?: PrivacyRecordStatus;
  @ApiPropertyOptional() @IsOptional() @IsDateString() sharedAt?: string;
}

export class UpdateDataSharingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  recipient?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  dataCategory?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  purpose?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  integration?: string;
  @ApiPropertyOptional({ enum: PrivacyRecordStatus })
  @IsOptional()
  @IsEnum(PrivacyRecordStatus)
  status?: PrivacyRecordStatus;
  @ApiPropertyOptional() @IsOptional() @IsDateString() sharedAt?: string;
}
