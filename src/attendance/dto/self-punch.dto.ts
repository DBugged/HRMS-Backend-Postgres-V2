import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  Max,
  Min,
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

  @ApiPropertyOptional({
    description:
      "The device's reported accuracy of this fix, in metres. A punch whose point is just outside the fence is accepted when the reading is that imprecise (allowance capped at 50 m); omitted = no allowance.",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  accuracyMeters?: number;
}
