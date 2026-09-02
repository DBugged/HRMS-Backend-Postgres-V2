import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LetterDataProfile } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateLetterTemplateDto {
  @ApiProperty({ example: 'Internship Completion Certificate' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ example: 'Certificate of Internship' })
  @IsString()
  @MinLength(1)
  title!: string;

  @ApiProperty({ example: 'This is to certify that {{employeeName}}...' })
  @IsString()
  @MinLength(1)
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
}
