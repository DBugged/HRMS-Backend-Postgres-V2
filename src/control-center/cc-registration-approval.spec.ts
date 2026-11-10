import { ConflictException, NotFoundException } from '@nestjs/common';
import { CcCustomersService } from './cc-customers.service';
import { forgetOrganizationStatus, isOrganizationActive } from '../common/org-status';

// Approving or rejecting a self-registered company (status PENDING) from the Control Center.
function setup(org: { id: string; name: string; companyName?: string; platformStatus: string } | null) {
  const prisma = {
    organization: {
      findFirst: jest.fn().mockResolvedValue(org),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ email: 'founder@acme.test', name: 'Jane' }]),
  };
  const email = { send: jest.fn().mockResolvedValue({ dryRun: false }) };
  const service = new CcCustomersService(prisma as never, {} as never, {} as never, email as never);
  jest.spyOn(service, 'get').mockResolvedValue({ id: org?.id } as never);
  const purge = jest.spyOn(service as unknown as { purge: () => Promise<unknown> }, 'purge').mockResolvedValue({} as never);
  return { service, prisma, email, purge };
}

const PENDING = { id: 'o1', name: 'Acme', companyName: 'Acme Corp', platformStatus: 'PENDING' };

describe('approveRegistration', () => {
  it('activates a pending company and emails the founder', async () => {
    const { service, prisma, email } = setup(PENDING);
    await service.approveRegistration('o1', 'admin@cc.test');
    expect(prisma.organization.updateMany).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { platformStatus: 'ACTIVE', isActive: true } });
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'founder@acme.test', subject: expect.stringContaining('approved') }));
  });

  it('refuses a company that is not awaiting approval, and an unknown one', async () => {
    await expect(setup({ ...PENDING, platformStatus: 'ACTIVE' }).service.approveRegistration('o1', 'a')).rejects.toBeInstanceOf(ConflictException);
    await expect(setup({ ...PENDING, platformStatus: 'SUSPENDED' }).service.approveRegistration('o1', 'a')).rejects.toBeInstanceOf(ConflictException);
    await expect(setup(null).service.approveRegistration('x', 'a')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('makes the company usable straight away (the status cache is cleared)', async () => {
    const { service } = setup(PENDING);
    const prisma = { organization: { findFirst: jest.fn().mockResolvedValueOnce({ isActive: false }).mockResolvedValue({ isActive: true }) } };
    expect(await isOrganizationActive(prisma as never, 'o1')).toBe(false);
    await service.approveRegistration('o1', 'a');
    expect(await isOrganizationActive(prisma as never, 'o1')).toBe(true);
    forgetOrganizationStatus();
  });
});

describe('rejectRegistration', () => {
  it('emails the reason, then removes the registration so the address can register again', async () => {
    const { service, email, purge } = setup(PENDING);
    await expect(service.rejectRegistration('o1', 'admin@cc.test', 'Not a real company')).resolves.toEqual({ rejected: true, id: 'o1' });
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'founder@acme.test', html: expect.stringContaining('Not a real company') }));
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('refuses a company that is not awaiting approval, and removes nothing', async () => {
    const { service, purge, email } = setup({ ...PENDING, platformStatus: 'ACTIVE' });
    await expect(service.rejectRegistration('o1', 'a')).rejects.toBeInstanceOf(ConflictException);
    expect(purge).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });
});
