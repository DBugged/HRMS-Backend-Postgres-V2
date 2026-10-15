import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_WORK_COMPENSATION_OPTIONS,
  assertValidWorkCompensation,
  pickWorkCompensation,
  resolveWorkCompensation,
  selectableWorkCompensation,
} from './work-compensation';

describe('work compensation options', () => {
  it('falls back to the built-in options when nothing is saved', () => {
    const s = resolveWorkCompensation({});
    expect(s.options).toEqual(DEFAULT_WORK_COMPENSATION_OPTIONS);
    expect(s.defaultKey).toBeNull();
  });

  it('the built-in options start at 0 and 0, and none of them is offered to an approver until it grants something', () => {
    expect(
      DEFAULT_WORK_COMPENSATION_OPTIONS.every(
        (o) => o.compOffDays === 0 && o.payDays === 0,
      ),
    ).toBe(true);
    const offered = selectableWorkCompensation(resolveWorkCompensation({}));
    expect(offered.options).toEqual([]);
    expect(offered.defaultKey).toBeNull();
  });

  it('a saved list keeps its 0 / 0 placeholders but offers only the options that grant something', () => {
    const saved = assertValidWorkCompensation({
      defaultKey: 'NONE_YET',
      options: [
        { key: 'NONE_YET', label: 'Not set up', compOffDays: 0, payDays: 0 },
        { key: 'PAY_1', label: '1 day pay', compOffDays: 0, payDays: 1 },
      ],
    });
    expect(saved.options).toHaveLength(2);
    const offered = selectableWorkCompensation(saved);
    expect(offered.options.map((o) => o.key)).toEqual(['PAY_1']);
    // The default pointed at a placeholder, so there is no default.
    expect(offered.defaultKey).toBeNull();
  });

  it('keeps saved options and drops a default that no longer exists', () => {
    const s = resolveWorkCompensation({
      defaultKey: 'GONE',
      options: [{ key: 'X', label: 'X', compOffDays: 1, payDays: 0 }],
    });
    expect(s.options).toHaveLength(1);
    expect(s.defaultKey).toBeNull();
  });

  it('accepts a valid list and trims it', () => {
    const s = assertValidWorkCompensation({
      defaultKey: 'PAY_2',
      options: [
        { key: 'PAY_2', label: ' 2 days pay ', compOffDays: 0, payDays: 2 },
        {
          key: 'CO_PAY_HALF',
          label: 'Comp-off + half day',
          compOffDays: 1,
          payDays: 0.5,
        },
      ],
    });
    expect(s.options[0].label).toBe('2 days pay');
    expect(s.defaultKey).toBe('PAY_2');
  });

  it.each([
    [{ options: [] }, /between 1 and/],
    [
      { options: [{ key: 'a b', label: 'x', compOffDays: 1, payDays: 0 }] },
      /capital letters/,
    ],
    [
      { options: [{ key: 'A', label: '', compOffDays: 1, payDays: 0 }] },
      /name/,
    ],
    [
      { options: [{ key: 'A', label: 'x', compOffDays: 1.3, payDays: 0 }] },
      /half a day/,
    ],
    [
      { options: [{ key: 'A', label: 'x', compOffDays: 11, payDays: 0 }] },
      /between 0 and 10/,
    ],
    [
      {
        options: [
          { key: 'A', label: 'x', compOffDays: 1, payDays: 0 },
          { key: 'A', label: 'y', compOffDays: 0, payDays: 1 },
        ],
      },
      /used twice/,
    ],
    [
      {
        defaultKey: 'Z',
        options: [{ key: 'A', label: 'x', compOffDays: 1, payDays: 0 }],
      },
      /default option/,
    ],
  ])('refuses a bad list %#', (input, message) => {
    expect(() => assertValidWorkCompensation(input)).toThrow(
      BadRequestException,
    );
    expect(() => assertValidWorkCompensation(input)).toThrow(message);
  });

  it('picks the requested option, else the default, else the hourly rate', () => {
    const s = selectableWorkCompensation(
      resolveWorkCompensation({
        defaultKey: 'PAY_1',
        options: [
          { key: 'COMP_OFF', label: 'Comp-off', compOffDays: 1, payDays: 0 },
          { key: 'PAY_1', label: '1 day pay', compOffDays: 0, payDays: 1 },
        ],
      }),
    );
    expect(pickWorkCompensation(s, 'COMP_OFF')?.key).toBe('COMP_OFF');
    expect(pickWorkCompensation(s, undefined)?.key).toBe('PAY_1');
    expect(
      pickWorkCompensation(resolveWorkCompensation({}), undefined),
    ).toBeNull();
    expect(() => pickWorkCompensation(s, 'NOPE')).toThrow(/not available/);
  });
});
