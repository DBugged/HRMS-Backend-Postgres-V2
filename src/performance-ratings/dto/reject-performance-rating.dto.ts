import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectPerformanceRatingDto {
  @ApiProperty({
    description:
      'Why the rating is rejected - required, so the manager knows what to fix.',
    maxLength: 500,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'A reason is required to reject a rating.' })
  @MaxLength(500)
  reason!: string;
}
