import { Role } from '@prisma/client';
import { reviewerScope } from './dept-scope';

// A small company: m1 manages a1 (who manages a2); a3 reports to someone else but sits in the department m1 heads.
const people = [
  { id: 'm1', departmentId: 'd1', reportingManagerId: null, additionalReportingManagerIds: [] },
  { id: 'a1', departmentId: 'd1', reportingManagerId: 'm1', additionalReportingManagerIds: [] },
  { id: 'a2', departmentId: 'd2', reportingManagerId: 'a1', additionalReportingManagerIds: [] },
  { id: 'a3', departmentId: 'd1', reportingManagerId: 'other', additionalReportingManagerIds: [] },
  { id: 'a4', departmentId: 'd3', reportingManagerId: 'other', additionalReportingManagerIds: ['m1'] },
];
const prisma = {
  department: { findMany: jest.fn(async () => [{ id: 'd1' }]) },
  user: { findMany: jest.fn(async () => people) },
} as never;

describe('reviewerScope', () => {
  it('limits a manager to themself and their reporting line, even for a department they head', async () => {
    const ids = await reviewerScope(prisma, { id: 'm1', role: Role.MANAGER }, 'org');
    expect([...(ids ?? [])].sort()).toEqual(['a1', 'a2', 'a4', 'm1']); // a3 is in the department but reports elsewhere
  });

  it('still lets HR who head a department see that department', async () => {
    const ids = await reviewerScope(prisma, { id: 'm1', role: Role.HR }, 'org');
    expect(ids).toContain('a3');
  });

  it('gives Admin everyone and an employee only themself', async () => {
    expect(await reviewerScope(prisma, { id: 'x', role: Role.ADMIN }, 'org')).toBeNull();
    expect(await reviewerScope(prisma, { id: 'a1', role: Role.EMPLOYEE }, 'org')).toEqual(['a1']);
  });
});
