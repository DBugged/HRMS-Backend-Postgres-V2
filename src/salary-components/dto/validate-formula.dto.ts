import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ValidateFormulaDto {
  @ApiProperty()
  @IsNotEmpty()
  formula!: string;

  @ApiPropertyOptional({
    description:
      'Exclude this component code from the "unknown reference" check (used when re-validating an existing formula-based component)',
  })
  @IsOptional()
  @IsString()
  excludeCode?: string;
}
