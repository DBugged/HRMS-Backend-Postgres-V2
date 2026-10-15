import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CityClass } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class HraChoiceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Percentage of Basic. Default 50 in a metro city, 40 elsewhere.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percent?: number;
}

class DaChoiceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Monthly amount.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000000)
  amount?: number;
}

class SchemesDto {
  @IsOptional() @IsBoolean() pf?: boolean;
  @IsOptional() @IsBoolean() esi?: boolean;
  @IsOptional() @IsBoolean() gratuity?: boolean;
  @IsOptional() @IsBoolean() bonus?: boolean;
  @IsOptional() @IsBoolean() nps?: boolean;
}

export class StructurePreviewDto {
  @ApiProperty({ enum: ['CTC', 'GROSS'] })
  @IsIn(['CTC', 'GROSS'])
  mode!: 'CTC' | 'GROSS';

  @ApiPropertyOptional({ description: 'Annual fixed CTC (mode CTC).' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000000)
  annualCtc?: number;

  @ApiPropertyOptional({ description: 'Monthly gross (mode GROSS).' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000000)
  monthlyGross?: number;

  @ApiPropertyOptional({
    description: 'Variable pay for the year, on top of the fixed package.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000000)
  variableAnnual?: number;

  @ApiPropertyOptional({
    description:
      'CTC mode only. true: the annual CTC includes the variable pay (fixed = CTC - variable). Otherwise the variable is paid on top of the fixed CTC.',
  })
  @IsOptional()
  @IsBoolean()
  variableIncludedInCtc?: boolean;

  @ApiPropertyOptional({
    enum: CityClass,
    description: 'Used when no work location is given.',
  })
  @IsOptional()
  @IsEnum(CityClass)
  cityClass?: CityClass;

  @ApiPropertyOptional({
    description: "The employee's work location; decides the city class.",
  })
  @IsOptional()
  @IsUUID()
  workLocationId?: string;

  @ApiPropertyOptional({
    description:
      "The employee's department; its work location is used when no work location is given.",
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  employeeType?: string;

  @ApiPropertyOptional({
    description:
      'Basic as a percentage of the total monthly package (default 50).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  basicPercent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => HraChoiceDto)
  hra?: HraChoiceDto;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => DaChoiceDto)
  da?: DaChoiceDto;

  @ApiPropertyOptional({
    description:
      'Fixed monthly allowances that are switched on: component code -> monthly amount.',
  })
  @IsOptional()
  @IsObject()
  allowances?: Record<string, number>;

  @ApiPropertyOptional({
    description:
      'Which schemes apply; absent = the defaults of the employee type.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SchemesDto)
  statutory?: SchemesDto;
}
