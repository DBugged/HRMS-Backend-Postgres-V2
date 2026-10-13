import { BadRequestException } from '@nestjs/common';
import { TdsComplianceController } from './tds-compliance.controller';

jest.mock('./form130-pdf', () => ({
  renderForm130: jest.fn(async () => Buffer.from('pdf')),
}));
jest.mock('../reports/report-branding', () => ({
  loadReportLogo: jest.fn(async () => null),
  sendReportBranded: jest.fn(),
}));

type Row = Record<string, any>;

function build(employee: Row) {
  const sent: Row[] = [];
  const controller = new TdsComplianceController(
    {
      form130Data: async () => ({
        formName: 'Form 130',
        employee: { code: 'DP-1' },
      }),
    } as never,
    { user: { findFirst: async () => employee } } as never,
    { send: async (m: Row) => sent.push(m) } as never,
  );
  return { controller, sent };
}

const caller = { id: 'hr', organizationId: 'org', role: 'HR' } as never;
const body = { financialYear: '2026-27' } as never;

describe('Form 130 by email', () => {
  it('goes to the personal email, with the PDF attached, once the company mailbox is closed', async () => {
    const { controller, sent } = build({
      id: 'e1',
      name: 'Asha',
      email: 'asha@acme.test',
      isActive: false,
      personalData: { personalEmail: 'asha@gmail.com' },
    });
    const res = await controller.emailForm130('e1', body, caller);
    expect(res).toMatchObject({
      sentTo: 'asha@gmail.com',
      toPersonalEmail: true,
    });
    expect(sent[0].to).toBe('asha@gmail.com');
    expect(sent[0].attachments[0].filename).toBe('Form130_DP-1_2026-27.pdf');
  });

  it('an employee still working falls back to the work address', async () => {
    const { controller } = build({
      id: 'e1',
      name: 'Asha',
      email: 'asha@acme.test',
      isActive: true,
      personalData: {},
    });
    const res = await controller.emailForm130('e1', body, caller);
    expect(res).toMatchObject({
      sentTo: 'asha@acme.test',
      toPersonalEmail: false,
    });
  });

  it('a leaver with no personal email is refused rather than mailed to a closed mailbox', async () => {
    const { controller, sent } = build({
      id: 'e1',
      name: 'Asha',
      email: 'asha@acme.test',
      isActive: false,
      personalData: {},
    });
    await expect(controller.emailForm130('e1', body, caller)).rejects.toThrow(
      BadRequestException,
    );
    expect(sent).toHaveLength(0);
  });
});
