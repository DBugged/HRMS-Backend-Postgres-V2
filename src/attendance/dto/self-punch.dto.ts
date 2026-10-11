import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
} from 'class-validator';

// selfieUrl is a plain client-supplied string — no upload endpoint exists
// in backend-v2 yet (see the Batch 6a plan's deferral note), same
// precedent as PayrollTemplate.companyLogoUrl/Leave.attachmentUrl.
export class SelfPunchDto {
  @ApiProperty()
  @IsLatitude()
  latitude!: number;

  @ApiProperty()
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  selfieUrl?: string;

  @ApiPropertyOptional({
    description:
      'True when the device reports that the location comes from a mock/fake-location app (Android reports this; iOS and browsers cannot). The punch is refused and the attempt is audited.',
  })
  @IsOptional()
  @IsBoolean()
  mockedLocation?: boolean;
}
