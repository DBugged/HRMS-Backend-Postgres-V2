import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class ReviewEmployeeDocumentDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({
    description:
      'Required (and shown to the employee) when the document is rejected.',
    maxLength: 500,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((o: ReviewEmployeeDocumentDto) => o.status === 'REJECTED')
  @IsNotEmpty({ message: 'A reason is required to reject a document.' })
  @IsString()
  @MaxLength(500)
  reason?: string;
}
