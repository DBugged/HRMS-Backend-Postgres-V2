import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreatePrivacyNoticeDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  body!: string;

  @ApiPropertyOptional({ description: 'Defaults to now when publishing' })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional({
    description: 'true (default) publishes immediately; false saves a draft',
  })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class UpdatePrivacyNoticeDraftDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export class PublishPrivacyNoticeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export class AcknowledgeNoticeDto {
  @ApiPropertyOptional({ description: 'Defaults to the current notice' })
  @IsOptional()
  @IsString()
  noticeVersionId?: string;
}
