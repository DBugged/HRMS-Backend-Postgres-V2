import { PartialType } from '@nestjs/swagger';
import { CreatePayrollTemplateDto } from './create-payroll-template.dto';

// isDefault is deliberately NOT included — only POST /:id/set-default can
// flip it, matching the old controller's explicit stripping of isDefault
// from PUT payloads.
export class UpdatePayrollTemplateDto extends PartialType(
  CreatePayrollTemplateDto,
) {}
