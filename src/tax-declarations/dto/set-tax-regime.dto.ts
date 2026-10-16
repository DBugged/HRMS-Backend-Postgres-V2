import { ApiProperty } from '@nestjs/swagger';
import { TaxRegime } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SetTaxRegimeDto {
  @ApiProperty({
    type: [String],
    description: 'One employee, or many for a bulk change.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  employeeIds!: string[];

  @ApiProperty({ example: '2026-27' })
  @Matches(/^\d{4}-\d{2}$/, {
    message: 'financialYear must look like 2026-27.',
  })
  financialYear!: string;

  @ApiProperty({ enum: TaxRegime })
  @IsEnum(TaxRegime)
  regime!: TaxRegime;

  // A change of someone's regime moves their TDS - the reason is the first thing asked when they query it.
  @ApiProperty({ minLength: 3, maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MinLength(3, { message: 'Give a reason for changing the regime.' })
  @MaxLength(300)
  reason!: string;
}
