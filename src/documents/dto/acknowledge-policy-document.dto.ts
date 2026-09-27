import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AcknowledgePolicyDocumentDto {
  // What the employee types as their signature — not required to match
  // their profile name verbatim (same as a wet-ink signature never being
  // machine-checked against a printed name either).
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  signatureName!: string;
}
