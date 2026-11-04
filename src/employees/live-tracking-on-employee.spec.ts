import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { EmployeesService, wantsTracking } from './employees.service';
import { registerModuleGate } from '../module-access/module-gate';

// Only the live-tracking pieces of the employee service: the Yes/No import cell, and who may switch tracking on.
describe('live tracking on an employee', () => {
  it('reads Yes in many spellings from the import sheet', () => {
    for (const yes of ['Yes', 'yes', ' Y ', 'TRUE', '1', 'On'])
      expect(wantsTracking(yes)).toBe(true);
    for (const no of ['', 'No', 'n', 'false', '0', 'maybe'])
      expect(wantsTracking(no)).toBe(false);
  });

  const svc = () =>
    new EmployeesService(
      ...(new Array(12).fill({}) as [
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
    );
  const may = (role: Role) =>
    (
      svc() as unknown as {
        assertMayTrack: (a: { role: Role }, org: string) => Promise<void>;
      }
    ).assertMayTrack({ role }, 'org');

  it('Admin and HR may; an employee or manager may not', async () => {
    await expect(may(Role.ADMIN)).resolves.toBeUndefined();
    await expect(may(Role.HR)).resolves.toBeUndefined();
    await expect(may(Role.EMPLOYEE)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(may(Role.MANAGER)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('is refused when the company does not have the feature on', async () => {
    registerModuleGate({ featureEnabledFor: async () => false } as never);
    try {
      await expect(may(Role.ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      registerModuleGate(null as never);
    }
  });
});
