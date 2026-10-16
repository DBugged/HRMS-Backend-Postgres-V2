import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsString, Max, Min } from 'class-validator';
import { IsValidCalendarDateString } from '../../common/is-valid-calendar-date.validator';

export class ApplyStatutorySetupDto {
  @ApiProperty({ example: 25 })
  @IsInt()
  @Min(1)
  @Max(1000000)
  employeeCount!: number;

  @ApiProperty({ example: 'Maharashtra' })
  @IsString()
  state!: string;

  @ApiProperty()
  @IsBoolean()
  pf!: boolean;

  @ApiProperty()
  @IsBoolean()
  esi!: boolean;

  @ApiProperty()
  @IsBoolean()
  pt!: boolean;

  @ApiProperty({ example: '2026-04-01' })
  @IsValidCalendarDateString()
  effectiveFrom!: string;
}
