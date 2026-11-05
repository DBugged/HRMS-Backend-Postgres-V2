import { ApiPropertyOptional } from '@nestjs/swagger';
import { LetterDataProfile } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { LETTER_STAGES } from '../../letters/letter-stages';

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

  // The stage of the employee's journey this letter belongs to (shown under that heading on the Letters tab). null / omitted = not part
  // of the flow (listed under "Other letters"). Only a custom template takes it; a built-in one's stage is fixed.
  @ApiPropertyOptional({ enum: LETTER_STAGES, nullable: true })
  @IsOptional()
  @IsIn(LETTER_STAGES as unknown as string[])
  journeyStage?: (typeof LETTER_STAGES)[number] | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
