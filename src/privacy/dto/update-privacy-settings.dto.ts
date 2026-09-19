import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// processingPurposes / dataCategories / retentionRules are validated structurally in PrivacyService
// (validateSettingsJson) so one bad element yields a precise 400 message.
export class UpdatePrivacySettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  privacyOfficerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  privacyOfficerEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  privacyOfficerPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  grievanceInfo?: string;

  @ApiPropertyOptional({ description: 'Response window in days (1-180)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  requestSlaDays?: number;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  processingPurposes?: unknown[];

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  dataCategories?: unknown[];

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  retentionRules?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  exportSettings?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  deletionRules?: Record<string, unknown>;
}
