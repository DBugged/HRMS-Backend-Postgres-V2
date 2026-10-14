import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
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
  // Required unless this employee's location rule is NOT_NEEDED (a selfie alone) - the service refuses a punch
  // without a location in every other case, and ignores any location sent when none is needed.
  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  longitude?: number;

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

  @ApiPropertyOptional({
    description:
      "The phone's battery level at punch time, 0-100, as the device reports it. Written on the stamped selfie and kept on the punch for context; it comes from the device, so it is not proof of anything.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  batteryPercent?: number;
}
