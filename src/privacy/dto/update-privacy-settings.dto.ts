import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateIf,
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
  @ValidateIf((o: UpdatePrivacySettingsDto) => !!o.privacyOfficerEmail)
  @IsEmail(
    {},
    { message: 'Privacy officer email must be a valid email address' },
  )
  @MaxLength(200)
  privacyOfficerEmail?: string;

  @ApiPropertyOptional()
  @ValidateIf((o: UpdatePrivacySettingsDto) => !!o.privacyOfficerPhone)
  @Matches(/^\+?[0-9][0-9\s()-]{8,18}[0-9]$/, {
    message:
      'Privacy officer phone must be a valid phone number (10–15 digits)',
  })
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
