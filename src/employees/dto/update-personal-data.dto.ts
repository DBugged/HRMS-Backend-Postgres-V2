import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

// Loosely-typed on purpose — the shape mirrors the old system's single
// personalData JSON blob (dob/address/personalEmail/bloodGroup, family +
// emergency contacts, free-text professional info, previousEmployment[]
// capped at 3 client-side, bank details, statutory IDs, references[]).
// Merge semantics live in personal-data.ts; nothing here is server-side
// whitelisted beyond "must be an object" since every field is optional and
// the whole blob is opaque to the rest of the app except the 8-field
// profileCompleted check.
export class UpdatePersonalDataDto {
  @ApiProperty({
    description: 'Partial personalData patch — merged onto the existing blob.',
  })
  @IsObject()
  personalData!: Record<string, unknown>;
}
