import {
  boardReportDueAt,
  boardReportState,
  withBoardDeadline,
} from './breach-deadline';

const H = 60 * 60 * 1000;
const now = new Date('2026-10-29T12:00:00Z');
const open = (
  hoursAgo: number,
  extra: Partial<Parameters<typeof boardReportState>[0]> = {},
) => ({
  detectedAt: new Date(now.getTime() - hoursAgo * H),
  status: 'OPEN' as const,
  notificationStatus: 'NOT_ASSESSED' as const,
  boardReportedAt: null,
  ...extra,
});

describe('breach-deadline', () => {
  it('puts the Board report 72 hours after detection', () => {
    expect(
      boardReportDueAt(new Date('2026-10-01T12:30:00Z')).toISOString(),
    ).toBe('2026-10-04T12:30:00.000Z');
  });

  it('is due, then due soon in the last 24 hours, then overdue', () => {
    expect(boardReportState(open(10), now)).toBe('DUE');
    expect(boardReportState(open(50), now)).toBe('DUE_SOON');
    expect(boardReportState(open(73), now)).toBe('OVERDUE');
  });

  it('stops counting once reported, not required, or closed', () => {
    expect(
      boardReportState(
        open(100, { notificationStatus: 'NOTIFIED', boardReportedAt: now }),
        now,
      ),
    ).toBe('REPORTED');
    expect(
      boardReportState(open(100, { notificationStatus: 'NOT_REQUIRED' }), now),
    ).toBe('NOT_REQUIRED');
    expect(boardReportState(open(100, { status: 'CLOSED' }), now)).toBe(
      'CLOSED',
    );
  });

  it('adds the due time and state to a register row', () => {
    const row = withBoardDeadline(
      { ...open(10), incidentNo: 'INC-00001' },
      now,
    );
    expect(row.incidentNo).toBe('INC-00001');
    expect(row.boardReportDueAt.getTime()).toBe(now.getTime() + 62 * H);
    expect(row.boardReportState).toBe('DUE');
  });
});
