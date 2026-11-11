import { AttendanceService } from './attendance.service';

// Approving a full day of leave on a day that already has a Work From Home request drops that request, so the day is not both
// leave and WFH. A half day of leave keeps it (the other half can still be worked).
describe('approving a leave on a day with Work From Home', () => {
  const wfhRow = {
    id: 'a1',
    date: '2026-11-09',
    status: 'ABSENT',
    source: 'FACE_API',
    leaveOverriddenStatus: null,
    leaveOverriddenSource: null,
    workArrangement: 'WFH',
    workArrangementStatus: 'APPROVED',
  };

  async function approve(isHalfDay: boolean) {
    const updates: Record<string, unknown>[] = [];
    const tx = {
      attendance: {
        findMany: async () => [wfhRow],
        updateMany: async (a: { data: Record<string, unknown> }) => {
          updates.push(a.data);
          return { count: 1 };
        },
        createMany: async () => ({ count: 0 }),
      },
    };
    const svc = Object.create(AttendanceService.prototype) as AttendanceService;
    await svc.writeAttendanceForApprovedLeave(
      tx as never,
      { employeeId: 'e1', startDate: '2026-11-09', endDate: '2026-11-09', isHalfDay } as never,
      'org',
    );
    return updates[0];
  }

  it('a full day of leave clears the Work From Home request', async () => {
    const data = await approve(false);
    expect(data.status).toBe('ON_LEAVE');
    expect(data.workArrangement).toBe('OFFICE');
    expect(data.workArrangementStatus).toBe('NONE');
  });

  it('a half day of leave leaves the Work From Home request alone', async () => {
    const data = await approve(true);
    expect(data.status).toBe('HALF_DAY');
    expect('workArrangement' in data).toBe(false);
  });
});
