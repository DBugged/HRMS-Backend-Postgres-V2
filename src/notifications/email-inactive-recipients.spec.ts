import { EmailService } from './email.service';

// Mail never goes to an inactive employee unless the caller says it is addressed to a leaver on purpose.
function build(inactive: string[]) {
  const prisma: any = {
    user: { findMany: jest.fn(async () => inactive.map((email) => ({ email }))) },
    organization: { findFirst: jest.fn(async () => null) },
  };
  const svc = new EmailService(prisma);
  // Past the guard the service resolves the sender and picks a provider: stop there and record what reached it.
  const reached: any[] = [];
  (svc as any).resolveFrom = jest.fn(async () => {
    reached.push('resolveFrom');
    return 'from@x.test';
  });
  return { svc, prisma, reached };
}

describe('EmailService: inactive recipients', () => {
  it('skips mail addressed to an inactive employee', async () => {
    const { svc, reached } = build(['gone@acme.test']);
    const r = await svc.send({ organizationId: 'o1', to: 'Gone@Acme.test', subject: 's', html: 'h' });
    expect(r).toEqual({ dryRun: true });
    expect(reached).toEqual([]);
  });

  it('delivers when the caller allows inactive recipients (a letter, a final payslip)', async () => {
    const { svc, prisma, reached } = build(['gone@acme.test']);
    await svc.send({ organizationId: 'o1', to: 'gone@acme.test', subject: 's', html: 'h', allowInactive: true });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(reached).toEqual(['resolveFrom']);
  });

  it('delivers to an active recipient', async () => {
    const { svc, reached } = build([]);
    await svc.send({ organizationId: 'o1', to: 'here@acme.test', subject: 's', html: 'h' });
    expect(reached).toEqual(['resolveFrom']);
  });

  it('drops inactive people from Cc and Bcc but still sends to the rest', async () => {
    const { svc, prisma } = build(['gone@acme.test']);
    const sendSpy = jest.spyOn(svc as any, 'getResend').mockImplementation(() => { throw new Error('stop'); });
    await svc.send({ organizationId: 'o1', to: 'here@acme.test', cc: ['gone@acme.test', 'ok@acme.test'], bcc: ['gone@acme.test'], subject: 's', html: 'h' });
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    sendSpy.mockRestore();
  });

  it('does not look anyone up without an organisation', async () => {
    const { svc, prisma } = build(['gone@acme.test']);
    await svc.send({ to: 'gone@acme.test', subject: 's', html: 'h' });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
