import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PayrollService } from './payroll.service';

// bulkUnlock runs the single unlock() once per run and reports the ones it could not unlock instead of stopping.
function service(unlock: jest.Mock) {
  const svc: any = Object.create(PayrollService.prototype);
  svc.unlock = unlock;
  return svc as PayrollService;
}
const actor: any = { id: 'a', role: 'ADMIN' };

describe('bulkUnlock', () => {
  it('unlocks every run with the one reason', async () => {
    const unlock = jest.fn(async (id: string) => ({ id }));
    const r = await service(unlock).bulkUnlock({ ids: ['r1', 'r2'], reason: 'Wrong LWP days' }, actor, 'org');
    expect(r.updatedCount).toBe(2);
    expect(r.skipped).toEqual([]);
    expect(unlock).toHaveBeenCalledWith('r1', { reason: 'Wrong LWP days' }, actor, 'org');
  });

  it('lists the runs that refuse, with why, and carries on with the rest', async () => {
    const unlock = jest.fn(async (id: string) => {
      if (id === 'r2') throw new ForbiddenException('Only an Admin can unlock payroll that is already marked as paid.');
      if (id === 'r3') throw new BadRequestException('Only locked or paid payroll can be unlocked.');
      return { id };
    });
    const r = await service(unlock).bulkUnlock({ ids: ['r1', 'r2', 'r3', 'r4'], reason: 'Wrong LWP days' }, actor, 'org');
    expect(r.updatedCount).toBe(2);
    expect(r.skipped).toEqual([
      { id: 'r2', status: 'unlock_refused', reason: 'Only an Admin can unlock payroll that is already marked as paid.' },
      { id: 'r3', status: 'unlock_refused', reason: 'Only locked or paid payroll can be unlocked.' },
    ]);
  });

  it('does the same run twice only once', async () => {
    const unlock = jest.fn(async (id: string) => ({ id }));
    await service(unlock).bulkUnlock({ ids: ['r1', 'r1'], reason: 'Wrong LWP days' }, actor, 'org');
    expect(unlock).toHaveBeenCalledTimes(1);
  });
});
