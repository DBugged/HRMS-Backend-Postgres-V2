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

import { EmailService } from './email.service';

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
    const result = await new EmailService().send(input);
    expect(result).toEqual({ dryRun: true });
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends via SMTP when EMAIL_DRIVER is unset but SMTP is configured', async () => {
    delete process.env.EMAIL_DRIVER;
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    sendMailMock.mockResolvedValueOnce(undefined);
    const result = await new EmailService().send(input);
    expect(result).toEqual({ dryRun: false });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('dry-runs when EMAIL_DRIVER=resend but RESEND_API_KEY is unset', async () => {
    process.env.EMAIL_DRIVER = 'resend';
    delete process.env.RESEND_API_KEY;
    const result = await new EmailService().send(input);
    expect(result).toEqual({ dryRun: true });
    expect(sendMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('sends via Resend when EMAIL_DRIVER=resend and RESEND_API_KEY is set', async () => {
    process.env.EMAIL_DRIVER = 'resend';
    process.env.RESEND_API_KEY = 'test_key';
    sendMock.mockResolvedValueOnce({ data: { id: 'abc' }, error: null });
    const result = await new EmailService().send(input);
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
    const result = await new EmailService().send(input);
    expect(result).toEqual({ dryRun: true });
  });
});
