const sendMock = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}));

const sendMailMock = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockImplementation(() => ({
    sendMail: sendMailMock,
  })),
}));

import { EmailService, isUndeliverableAddress } from './email.service';

describe('EmailService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  const input = { to: 'a@b.com', subject: 'Hi', html: '<p>Hello</p>' };

  it('defaults to SMTP dry-run when neither driver is configured', async () => {
    delete process.env.EMAIL_DRIVER;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const result = await new EmailService({} as any).send(input);
    expect(result).toEqual({ dryRun: true });
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends via SMTP when EMAIL_DRIVER is unset but SMTP is configured', async () => {
    delete process.env.EMAIL_DRIVER;
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    sendMailMock.mockResolvedValueOnce(undefined);
    const result = await new EmailService({} as any).send(input);
    expect(result).toEqual({ dryRun: false });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('dry-runs when EMAIL_DRIVER=resend but RESEND_API_KEY is unset', async () => {
    process.env.EMAIL_DRIVER = 'resend';
    delete process.env.RESEND_API_KEY;
    const result = await new EmailService({} as any).send(input);
    expect(result).toEqual({ dryRun: true });
    expect(sendMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('sends via Resend when EMAIL_DRIVER=resend and RESEND_API_KEY is set', async () => {
    process.env.EMAIL_DRIVER = 'resend';
    process.env.RESEND_API_KEY = 'test_key';
    sendMock.mockResolvedValueOnce({ data: { id: 'abc' }, error: null });
    const result = await new EmailService({} as any).send(input);
    expect(result).toEqual({ dryRun: false });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('falls back to dry-run when Resend returns an error', async () => {
    process.env.EMAIL_DRIVER = 'resend';
    process.env.RESEND_API_KEY = 'test_key';
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'invalid_from_address' },
    });
    const result = await new EmailService({} as any).send(input);
    expect(result).toEqual({ dryRun: true });
  });

  describe('addresses that can never be delivered', () => {
    it('recognises the reserved test domains', () => {
      for (const a of [
        'cold196@loadtest.qa.test',
        'x@tenantb.test',
        'y@example.com',
        'z@company.example',
        'a@host.invalid',
        'b@localhost',
      ]) {
        expect(isUndeliverableAddress(a)).toBe(true);
      }
      for (const a of ['me@gmail.com', 'hr@acme.co.in', 'a@b.com']) {
        expect(isUndeliverableAddress(a)).toBe(false);
      }
    });

    it('never hands one to the provider', async () => {
      process.env.SMTP_USER = 'user';
      process.env.SMTP_PASS = 'pass';
      delete process.env.EMAIL_DRIVER;
      const result = await new EmailService({} as any).send({
        ...input,
        to: 'cold1@loadtest.qa.test',
      });
      expect(result).toEqual({ dryRun: true });
      expect(sendMailMock).not.toHaveBeenCalled();
    });
  });

  it('pauses SMTP sends after the provider refuses the login, instead of retrying every message', async () => {
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    delete process.env.EMAIL_DRIVER;
    sendMailMock.mockRejectedValueOnce(
      Object.assign(
        new Error('Invalid login: 454-4.7.0 Too many login attempts'),
        {
          code: 'EAUTH',
          responseCode: 454,
        },
      ),
    );
    const service = new EmailService({} as any);
    expect(await service.send(input)).toEqual({ dryRun: true });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    // the next sends are skipped without touching the provider
    expect(await service.send({ ...input, to: 'c@d.com' })).toEqual({
      dryRun: true,
    });
    expect(await service.send({ ...input, to: 'e@f.com' })).toEqual({
      dryRun: true,
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});
