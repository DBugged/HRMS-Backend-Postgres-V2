import { cascadeOrgAttendanceDefaults } from './org-attendance-sync';

describe('cascadeOrgAttendanceDefaults', () => {
  const run = async (oldP: object, newP: object) => {
    const calls: Array<{ where: any; data: any }> = [];
    const db = {
      department: {
        updateMany: (a: { where: any; data: any }) => {
          calls.push(a);
          return Promise.resolve({ count: 0 });
        },
      },
    };
    await cascadeOrgAttendanceDefaults(db, 'org1', oldP, newP);
    return calls;
  };

  it('moves departments without a Work Schedule to the new org shift hours', async () => {
    const calls = await run(
      { defaultShiftStartTime: '09:30', defaultShiftEndTime: '18:30' },
      { defaultShiftStartTime: '10:00', defaultShiftEndTime: '19:00' },
    );
    const start = calls.find((c) => 'shiftStartTime' in c.data)!;
    expect(start.where).toMatchObject({
      organizationId: 'org1',
      shiftStartTime: '09:30',
      workScheduleId: null,
    });
    expect(start.data).toEqual({ shiftStartTime: '10:00' });
    const end = calls.find((c) => 'shiftEndTime' in c.data)!;
    expect(end.where).toMatchObject({
      shiftEndTime: '18:30',
      workScheduleId: null,
    });
    expect(end.data).toEqual({ shiftEndTime: '19:00' });
  });

  it('does nothing when the shift hours did not change', async () => {
    const calls = await run(
      { defaultShiftStartTime: '09:30', defaultShiftEndTime: '18:30' },
      { defaultShiftStartTime: '09:30', defaultShiftEndTime: '18:30' },
    );
    expect(calls).toHaveLength(0);
  });
});
