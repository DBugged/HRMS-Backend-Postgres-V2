import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DpaStatus, PrivacyRecordStatus } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateDataProcessorDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) service!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  dataProcessed?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  purpose?: string;
  @ApiPropertyOptional({ enum: DpaStatus })
  @IsOptional()
  @IsEnum(DpaStatus)
  dpaStatus?: DpaStatus;
  @ApiPropertyOptional({ enum: PrivacyRecordStatus })
  @IsOptional()
  @IsEnum(PrivacyRecordStatus)
  status?: PrivacyRecordStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateDataProcessorDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  service?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  dataProcessed?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  purpose?: string;
  @ApiPropertyOptional({ enum: DpaStatus })
  @IsOptional()
  @IsEnum(DpaStatus)
  dpaStatus?: DpaStatus;
  @ApiPropertyOptional({ enum: PrivacyRecordStatus })
  @IsOptional()
  @IsEnum(PrivacyRecordStatus)
  status?: PrivacyRecordStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
