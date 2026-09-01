import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class UpdateEmailSignatureDto {
  // Deliberately not @IsNotEmpty — an empty string is how a signature gets
  // cleared (appendSignature() treats a blank/whitespace-only value as
  // "no signature set").
  @ApiProperty({ example: '<p>Regards,<br/>{{companyName}} HR Team</p>' })
  @IsString()
  signatureHtml!: string;
}
