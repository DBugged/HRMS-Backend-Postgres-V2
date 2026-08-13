import { Role } from '@prisma/client';
import { stripLockedFields } from './employee-field-lock';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

const FULL_UPDATE: UpdateEmployeeDto = {
  name: 'New Name',
  email: 'new@example.test',
  departmentId: 'dept-1',
  designation: 'Senior Engineer',
  contactNumber: '1234567890',
  joiningDate: '2026-01-01',
  role: Role.MANAGER,
  reportingManagerId: 'mgr-1',
  employmentStatus: 'CONFIRMED',
  isActive: false,
};

describe('stripLockedFields', () => {
  it('EMPLOYEE (self-update): strips every locked field, including designation', () => {
    const result = stripLockedFields(FULL_UPDATE, Role.EMPLOYEE);
    expect(result).toEqual({ name: 'New Name', contactNumber: '1234567890' });
  });

  it('MANAGER (self-update, not HR): same as EMPLOYEE — MANAGER is not in the HR/ADMIN self-vs-HR split', () => {
    const result = stripLockedFields(FULL_UPDATE, Role.MANAGER);
    expect(result).toEqual({ name: 'New Name', contactNumber: '1234567890' });
  });

  it('HR: keeps the generally-locked fields, but still loses designation (Admin-only)', () => {
    const result = stripLockedFields(FULL_UPDATE, Role.HR);
    expect(result).toEqual({
      name: 'New Name',
      email: 'new@example.test',
      departmentId: 'dept-1',
      contactNumber: '1234567890',
      joiningDate: '2026-01-01',
      role: Role.MANAGER,
      reportingManagerId: 'mgr-1',
      employmentStatus: 'CONFIRMED',
      isActive: false,
      // designation intentionally absent
    });
    expect(result).not.toHaveProperty('designation');
  });

  it('ADMIN: keeps everything, including designation', () => {
    const result = stripLockedFields(FULL_UPDATE, Role.ADMIN);
    expect(result).toEqual(FULL_UPDATE);
  });

  it('does not mutate the original dto object', () => {
    const original = { ...FULL_UPDATE };
    stripLockedFields(FULL_UPDATE, Role.EMPLOYEE);
    expect(FULL_UPDATE).toEqual(original);
  });

  it('handles a partial dto (only some fields present) the same way', () => {
    const result = stripLockedFields(
      { name: 'Just A Name', role: Role.ADMIN },
      Role.EMPLOYEE,
    );
    expect(result).toEqual({ name: 'Just A Name' });
  });
});
