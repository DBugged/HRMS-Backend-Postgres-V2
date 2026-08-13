import { Role } from '@prisma/client';
import {
  canManagerAccessEmployee,
  resolveDepartmentFilter,
} from './employee-query-scope';

describe('resolveDepartmentFilter', () => {
  it('MANAGER: forces their own department, ignoring the requested one entirely', () => {
    const actor = { role: Role.MANAGER, departmentId: 'dept-mine' };
    expect(resolveDepartmentFilter(actor, 'dept-someone-elses')).toBe(
      'dept-mine',
    );
  });

  it('MANAGER with no department assigned: resolves to undefined (no results, not "all results")', () => {
    const actor = { role: Role.MANAGER, departmentId: null };
    expect(resolveDepartmentFilter(actor, 'dept-x')).toBeUndefined();
  });

  it.each([Role.ADMIN, Role.HR, Role.EMPLOYEE])(
    '%s: passes the requested department through unchanged',
    (role) => {
      const actor = { role, departmentId: 'dept-mine' };
      expect(resolveDepartmentFilter(actor, 'dept-requested')).toBe(
        'dept-requested',
      );
    },
  );

  it.each([Role.ADMIN, Role.HR, Role.EMPLOYEE])(
    '%s: no filter requested -> undefined (no department scoping)',
    (role) => {
      const actor = { role, departmentId: 'dept-mine' };
      expect(resolveDepartmentFilter(actor, undefined)).toBeUndefined();
    },
  );
});

describe('canManagerAccessEmployee', () => {
  it.each([Role.ADMIN, Role.HR, Role.EMPLOYEE])(
    "%s: always true — this function only restricts MANAGER, other roles are the guard's concern",
    (role) => {
      expect(
        canManagerAccessEmployee({ role, departmentId: 'dept-1' }, 'dept-2'),
      ).toBe(true);
    },
  );

  it('MANAGER: true when the target is in their own department', () => {
    const actor = { role: Role.MANAGER, departmentId: 'dept-1' };
    expect(canManagerAccessEmployee(actor, 'dept-1')).toBe(true);
  });

  it('MANAGER: false when the target is in a different department', () => {
    const actor = { role: Role.MANAGER, departmentId: 'dept-1' };
    expect(canManagerAccessEmployee(actor, 'dept-2')).toBe(false);
  });

  it('MANAGER: false when the target has no department at all', () => {
    const actor = { role: Role.MANAGER, departmentId: 'dept-1' };
    expect(canManagerAccessEmployee(actor, null)).toBe(false);
  });

  it('MANAGER with no department themselves: false even if the target also has none (null !== null is avoided explicitly)', () => {
    const actor = { role: Role.MANAGER, departmentId: null };
    expect(canManagerAccessEmployee(actor, null)).toBe(false);
  });
});
