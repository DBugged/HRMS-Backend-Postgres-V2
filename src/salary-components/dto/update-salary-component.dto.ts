import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
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
}
