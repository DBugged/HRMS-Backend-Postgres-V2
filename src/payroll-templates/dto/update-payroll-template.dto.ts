import { OmitType, PartialType } from '@nestjs/swagger';
import { CreatePayrollTemplateDto } from './create-payroll-template.dto';

// isDefault is deliberately NOT part of an update — only POST /:id/set-default can flip it (so there is always exactly
// one default template; PUT used to accept isDefault:false and leave the organization with none).
export class UpdatePayrollTemplateDto extends PartialType(
  OmitType(CreatePayrollTemplateDto, ['isDefault'] as const),
) {}
