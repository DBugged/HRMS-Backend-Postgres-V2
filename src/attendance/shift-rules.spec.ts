import {
  pickShiftRule,
  shiftDepartmentFor,
  type ShiftRuleLite,
} from './shift-rules';

const dept = {
  id: 'd1',
  shiftStartTime: '09:30',
  shiftEndTime: '18:30',
  lateInThresholdMinutes: 15,
  earlyOutThresholdMinutes: 15,
  minHoursForPresent: 7,
  minHoursForHalfDay: 4,
  weeklyOffs: [0],
  breakMinutes: 60,
  crossesMidnight: false,
};
const rule = (o: Partial<ShiftRuleLite>): ShiftRuleLite => ({
  gender: 'FEMALE',
  startTime: '10:00',
  endTime: '18:00',
  breakMinutes: null,
  departmentIds: [],
  isActive: true,
  ...o,
});

describe('shift rules', () => {
  it('leaves the department shift alone when no rule matches', () => {
    expect(shiftDepartmentFor(dept, { gender: 'MALE' }, [rule({})])).toBe(dept);
    expect(shiftDepartmentFor(dept, { gender: null }, [rule({})])).toBe(dept);
  });
  it('lays the timing of a matching rule over the department', () => {
    const out = shiftDepartmentFor(dept, { gender: 'FEMALE' }, [rule({})])!;
    expect(out.shiftStartTime).toBe('10:00');
    expect(out.shiftEndTime).toBe('18:00');
    expect(out.breakMinutes).toBe(60);
    expect(out.weeklyOffs).toEqual([0]);
  });
  it('a department rule beats a company-wide one; inactive rules are ignored', () => {
    const wide = rule({ startTime: '10:00' });
    const narrow = rule({ startTime: '11:00', departmentIds: ['d1'] });
    expect(pickShiftRule([wide, narrow], 'FEMALE', 'd1')).toBe(narrow);
    expect(pickShiftRule([wide, narrow], 'FEMALE', 'd2')).toBe(wide);
    expect(
      pickShiftRule([{ ...wide, isActive: false }], 'FEMALE', 'd1'),
    ).toBeNull();
  });
  it('marks a shift that ends before it starts as crossing midnight', () => {
    expect(
      shiftDepartmentFor(dept, { gender: 'FEMALE' }, [
        rule({ startTime: '22:00', endTime: '06:00' }),
      ])!.crossesMidnight,
    ).toBe(true);
  });
  it('does nothing without a department', () => {
    expect(
      shiftDepartmentFor(null, { gender: 'FEMALE' }, [rule({})]),
    ).toBeNull();
  });
});
