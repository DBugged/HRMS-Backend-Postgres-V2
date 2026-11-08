import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentImportRowDto } from '../payroll/dto/payment.dto';
import { CreateChallanDto } from '../tds-compliance/dto/tds.dto';
import { CreateEmailTemplateDto } from '../email-templates/dto/create-email-template.dto';
import { CreateLetterTemplateDto } from '../letter-templates/dto/create-letter-template.dto';
import { CreatePolicyDocumentDto } from '../documents/dto/create-policy-document.dto';

// Which properties fail validation for `body` (an empty list means it passes).
async function failing<T extends object>(cls: new () => T, body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(cls, body) as object);
  return errors.map((e) => e.property);
}

describe('DTO limits', () => {
  const payment = { paymentReference: 'UTR123456', payslipNumber: 'PS-1' };

  it('payment import: amount must be above zero', async () => {
    expect(await failing(PaymentImportRowDto, { ...payment, amount: 100.5 })).toEqual([]);
    expect(await failing(PaymentImportRowDto, { ...payment, amount: 0 })).toContain('amount');
    expect(await failing(PaymentImportRowDto, { ...payment, amount: -5 })).toContain('amount');
  });

  it('TDS challan: interest and fee have an upper bound', async () => {
    const challan = { month: 5, year: 2026, bsrCode: '1234567', challanSerialNo: '12345', depositDate: '2026-05-07', tdsAmount: 100 };
    expect(await failing(CreateChallanDto, { ...challan, interest: 10, fee: 5 })).toEqual([]);
    expect(await failing(CreateChallanDto, { ...challan, interest: 2_000_000_000 })).toContain('interest');
    expect(await failing(CreateChallanDto, { ...challan, fee: 2_000_000_000 })).toContain('fee');
  });

  it('email template: name, subject and body lengths are capped', async () => {
    const ok = { name: 'Welcome', subject: 'Hello', bodyHtml: '<p>Hi</p>' };
    expect(await failing(CreateEmailTemplateDto, ok)).toEqual([]);
    expect(await failing(CreateEmailTemplateDto, { ...ok, name: 'x'.repeat(101) })).toContain('name');
    expect(await failing(CreateEmailTemplateDto, { ...ok, subject: 'x'.repeat(201) })).toContain('subject');
    expect(await failing(CreateEmailTemplateDto, { ...ok, bodyHtml: 'x'.repeat(100001) })).toContain('bodyHtml');
  });

  it('letter template: name, title and body lengths are capped', async () => {
    const ok = { name: 'Offer', title: 'Offer letter', bodyText: 'Dear {{employeeName}},' };
    expect(await failing(CreateLetterTemplateDto, ok)).toEqual([]);
    expect(await failing(CreateLetterTemplateDto, { ...ok, name: 'x'.repeat(101) })).toContain('name');
    expect(await failing(CreateLetterTemplateDto, { ...ok, title: 'x'.repeat(201) })).toContain('title');
    expect(await failing(CreateLetterTemplateDto, { ...ok, bodyText: 'x'.repeat(50001) })).toContain('bodyText');
  });

  it('policy document: title, category, file name and file link are capped', async () => {
    const ok = { title: 'Leave policy', category: 'HR', fileUrl: '/uploads/a.pdf', fileName: 'a.pdf' };
    expect(await failing(CreatePolicyDocumentDto, ok)).toEqual([]);
    expect(await failing(CreatePolicyDocumentDto, { ...ok, title: 'x'.repeat(201) })).toContain('title');
    expect(await failing(CreatePolicyDocumentDto, { ...ok, category: 'x'.repeat(101) })).toContain('category');
    expect(await failing(CreatePolicyDocumentDto, { ...ok, fileName: 'x'.repeat(256) })).toContain('fileName');
    expect(await failing(CreatePolicyDocumentDto, { ...ok, fileUrl: 'x'.repeat(1001) })).toContain('fileUrl');
  });
});
