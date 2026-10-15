import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Length, ValidateIf } from 'class-validator';

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
  @IsString({ message: 'A reason is required to reject a document.' })
  @Length(1, 500, {
    message:
      'A reason is required to reject a document (at most 500 characters).',
  })
  reason?: string;
}
