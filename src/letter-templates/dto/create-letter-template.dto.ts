import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LetterDataProfile } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator';
import { LETTER_STAGES } from '../../letters/letter-stages';

export class CreateLetterTemplateDto {
  @ApiProperty({ example: 'Internship Completion Certificate' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'Certificate of Internship' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ example: 'This is to certify that {{employeeName}}...' })
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  bodyText!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  addressedToEmployee?: boolean;

  @ApiPropertyOptional({
    enum: LetterDataProfile,
    default: LetterDataProfile.BASIC,
  })
  @IsOptional()
  @IsEnum(LetterDataProfile)
  dataProfile?: LetterDataProfile;

  // The stage of the employee's journey this letter belongs to (shown under that heading on the Letters tab). null / omitted = not part
  // of the flow (listed under "Other letters"). Only a custom template takes it; a built-in one's stage is fixed.
  @ApiPropertyOptional({ enum: LETTER_STAGES, nullable: true })
  @IsOptional()
  @IsIn(LETTER_STAGES as unknown as string[])
  journeyStage?: (typeof LETTER_STAGES)[number] | null;
}
