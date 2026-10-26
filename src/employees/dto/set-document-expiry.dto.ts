import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, Matches, ValidateIf } from 'class-validator';

export class SetDocumentExpiryDto {
  @ApiProperty({
    nullable: true,
    description: 'YYYY-MM-DD the document stops being valid, or null to clear it (a document that never expires).',
  })
  @ValidateIf((_o, v) => v !== null)
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Expiry date must be YYYY-MM-DD.' })
  expiryDate!: string | null;
}
