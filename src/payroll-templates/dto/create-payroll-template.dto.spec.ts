import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePayrollTemplateDto } from './create-payroll-template.dto';

const base = {
  name: 'Standard',
  companyName: 'Demo Company',
  signatoryName: 'A Person',
  signatoryDesignation: 'Director',
};

async function errorsFor(extra: Record<string, unknown>) {
  const dto = plainToInstance(CreatePayrollTemplateDto, { ...base, ...extra });
  const errors = await validate(dto, { whitelist: true });
  return { dto, errors: errors.map((e) => e.property) };
}

describe('CreatePayrollTemplateDto headerColor', () => {
  it('accepts a blank header colour (use the primary colour) and turns it into null', async () => {
    const { dto, errors } = await errorsFor({ headerColor: '' });
    expect(errors).not.toContain('headerColor');
    expect(dto.headerColor).toBeNull();
  });

  it('treats a whitespace-only value as blank too', async () => {
    const { dto, errors } = await errorsFor({ headerColor: '   ' });
    expect(errors).not.toContain('headerColor');
    expect(dto.headerColor).toBeNull();
  });

  it('accepts a valid hex colour', async () => {
    const { errors } = await errorsFor({ headerColor: '#5546e0' });
    expect(errors).not.toContain('headerColor');
  });

  it('still refuses a value that is not a hex colour', async () => {
    const { errors } = await errorsFor({ headerColor: 'purple' });
    expect(errors).toContain('headerColor');
  });
});
