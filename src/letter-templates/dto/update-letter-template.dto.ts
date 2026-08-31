import { ApiPropertyOptional } from '@nestjs/swagger';
import { LetterDataProfile } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class UpdateLetterTemplateDto {
  @ApiPropertyOptional({ example: 'Offer Letter' })
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'Offer of Employment' })
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ example: 'Dear {{employeeName}}, ...' })
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  bodyText?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  addressedToEmployee?: boolean;

  // Not offered on built-in (isCustom: false) templates — their data
  // profile is load-bearing (LettersService's own onboarding/exit flows
  // key off it), so the update path silently ignores this field for them
  // rather than letting an edit accidentally break generation. Freely
  // changeable on a custom template.
  @ApiPropertyOptional({ enum: LetterDataProfile })
  @IsOptional()
  @IsEnum(LetterDataProfile)
  dataProfile?: LetterDataProfile;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
