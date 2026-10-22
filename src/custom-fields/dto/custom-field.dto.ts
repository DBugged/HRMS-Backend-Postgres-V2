import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CUSTOM_FIELD_TYPES } from '../custom-field-values';

export class CreateCustomFieldDto {
  @ApiProperty({ example: 'Blood group' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  label!: string;

  @ApiProperty({ enum: CUSTOM_FIELD_TYPES })
  @IsIn(CUSTOM_FIELD_TYPES as unknown as string[])
  type!: (typeof CUSTOM_FIELD_TYPES)[number];

  @ApiPropertyOptional({ description: 'The choices of a DROPDOWN.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  options?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  helpText?: string;

  @ApiPropertyOptional({ description: 'The heading it is shown under on the profile.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  section?: string;

  @ApiPropertyOptional({ description: 'Whether the employee can fill in / change their own value.' })
  @IsOptional()
  @IsBoolean()
  employeeEditable?: boolean;
}

// The type and key of a field never change (the values are stored under them); everything else can.
export class UpdateCustomFieldDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  options?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  helpText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  section?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  employeeEditable?: boolean;

  @ApiPropertyOptional({ description: 'false switches the field off; the values already entered are kept.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  displayOrder?: number;
}

export class UpdateCustomFieldValuesDto {
  @ApiProperty({ description: 'The values to set, by field key: { "blood_group": "O+" }. A blank clears the value.' })
  @IsObject()
  values!: Record<string, unknown>;
}
