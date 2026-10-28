import { AttendanceStatus as S } from '@prisma/client';
import { alwaysPresentApplies, shiftMinutes } from './always-present';

const on = { alwaysPresent: true, alwaysPresentFrom: '2026-11-01' };

describe('alwaysPresentApplies', () => {
  it('turns an absent, half or incomplete day into present, from the effective date', () => {
    for (const s of [S.ABSENT, S.HALF_DAY, S.INCOMPLETE]) expect(alwaysPresentApplies(on, '2026-11-05', s)).toBe(true);
  });
  it('leaves approved leave, weekly offs, holidays and present days alone', () => {
    for (const s of [S.ON_LEAVE, S.WEEKLY_OFF, S.HOLIDAY, S.PRESENT]) expect(alwaysPresentApplies(on, '2026-11-05', s)).toBe(false);
  });
  it('does nothing before the effective date, when not marked, or with no effective date set it applies from the start', () => {
    expect(alwaysPresentApplies(on, '2026-10-31', S.ABSENT)).toBe(false);
    expect(alwaysPresentApplies({ alwaysPresent: false, alwaysPresentFrom: null }, '2026-11-05', S.ABSENT)).toBe(false);
    expect(alwaysPresentApplies({ alwaysPresent: true, alwaysPresentFrom: null }, '2026-11-05', S.ABSENT)).toBe(true);
    expect(alwaysPresentApplies(on, '2026-11-01', S.ABSENT)).toBe(true);
  });
});

describe('shiftMinutes', () => {
  it('is the shift length less the break', () => {
    expect(shiftMinutes('09:30', '18:30', false, 0)).toBe(540);
    expect(shiftMinutes('09:30', '18:30', false, 60)).toBe(480);
  });
  it('wraps a shift that crosses midnight', () => {
    expect(shiftMinutes('22:00', '06:00', true, 0)).toBe(480);
  });
  it('is never negative', () => {
    expect(shiftMinutes('10:00', '10:30', false, 60)).toBe(0);
  });
});
