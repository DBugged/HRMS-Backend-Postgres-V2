import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';
import { CreateSalaryComponentDto } from './create-salary-component.dto';

// `code` is accepted here for a stable request shape but is always
// stripped before persisting (see SalaryComponentsService.update) — it's
// immutable after creation, same as the old controller.
export class UpdateSalaryComponentDto extends PartialType(
  CreateSalaryComponentDto,
) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // Also settable one-swap-at-a-time via POST /salary-components/reorder
  // (the table's up/down arrows) — this lets the Edit modal's own Display
  // Order field set an exact value directly instead.
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}
