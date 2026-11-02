import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { EmployeesService } from './employees.service';

// The joining-date rule: HR may correct it once, an Admin as often as needed, and nobody once payroll has been processed.
function service(processed: boolean) {
  const prisma: any = { payrollRun: { findFirst: jest.fn().mockResolvedValue(processed ? { id: 'run' } : null) } };
  const svc: any = Object.create(EmployeesService.prototype);
  svc.scopedPrisma = prisma;
  return svc as { assertJoiningDateChangeAllowed: (b: any, d: string | undefined, o: string, r: Role) => Promise<{ newDate: string } | null> };
}
const before = (changed: boolean) => ({ id: 'e1', joiningDate: new Date('2026-01-10T00:00:00.000Z'), joiningDateChangedAt: changed ? new Date() : null });

describe('joining date change rule', () => {
  it('lets HR correct it once, then refuses with a pointer to the Admin', async () => {
    const svc = service(false);
    await expect(svc.assertJoiningDateChangeAllowed(before(false), '2026-01-12', 'o', Role.HR)).resolves.toEqual({ newDate: '2026-01-12' });
    await expect(svc.assertJoiningDateChangeAllowed(before(true), '2026-01-12', 'o', Role.HR)).rejects.toThrow('Only an Admin can change it again');
  });

  it('lets an Admin correct it again and again', async () => {
    const svc = service(false);
    await expect(svc.assertJoiningDateChangeAllowed(before(true), '2026-01-15', 'o', Role.ADMIN)).resolves.toEqual({ newDate: '2026-01-15' });
  });

  it('is frozen for everyone once payroll has been processed', async () => {
    const svc = service(true);
    await expect(svc.assertJoiningDateChangeAllowed(before(true), '2026-01-15', 'o', Role.ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.assertJoiningDateChangeAllowed(before(false), '2026-01-15', 'o', Role.HR)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignores an unchanged or missing date', async () => {
    const svc = service(true);
    await expect(svc.assertJoiningDateChangeAllowed(before(true), '2026-01-10', 'o', Role.HR)).resolves.toBeNull();
    await expect(svc.assertJoiningDateChangeAllowed(before(true), undefined, 'o', Role.ADMIN)).resolves.toBeNull();
  });
});
