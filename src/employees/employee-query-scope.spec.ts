import { Role as RoleForDirectory } from '@prisma/client';
import { employeeDirectoryScope, slimForEmployeeViewer } from './employee-query-scope';

describe('employee directory for an EMPLOYEE viewer', () => {
  it('shows only people who still work here, plus the caller own record', () => {
    expect(employeeDirectoryScope({ id: 'me', role: RoleForDirectory.EMPLOYEE, departmentId: null })).toEqual({
      OR: [{ isActive: true }, { id: 'me' }],
    });
    expect(employeeDirectoryScope({ id: 'm', role: RoleForDirectory.MANAGER, departmentId: null })).toBeUndefined();
    expect(employeeDirectoryScope({ id: 'a', role: RoleForDirectory.ADMIN, departmentId: null })).toBeUndefined();
  });

  it('keeps who and where in the reporting line, drops email, phone and the rest', () => {
    const slim = slimForEmployeeViewer({
      id: '1', name: 'A', employeeId: 'E1', role: 'EMPLOYEE', departmentId: 'd', reportingManagerId: 'm', isActive: true,
      email: 'a@x.test', contactNumber: '999', gender: 'MALE', probationEndDate: '2026-01-01', personalData: { pan: 'X' },
    });
    expect(slim).toEqual({ id: '1', name: 'A', employeeId: 'E1', role: 'EMPLOYEE', departmentId: 'd', reportingManagerId: 'm', isActive: true });
    expect(slim).not.toHaveProperty('email');
  });
});
