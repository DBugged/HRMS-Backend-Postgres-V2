import {
  applicationDocumentRule,
  checkLeaveRules,
  effectiveLeaveRules,
  LeaveRules,
  rangesOverlap,
  splitDaysByYear,
} from './leave-rules';

const permissiveRules: LeaveRules = {
  minDurationDays: 0.5,
  maxDurationDays: null,
  noticePeriodDays: 0,
  allowBackdated: true,
  maxBackdateDays: 365,
  allowFutureDated: true,
  maxAdvanceDays: null,
  allowHalfDay: true,
  sandwichLeaveApplies: false,
  restrictPrefixSuffixHoliday: false,
  maxConsecutiveDays: null,
  minGapBetweenRequestsDays: 0,
};

const baseContext = {
  today: '2026-06-01',
  holidayDates: new Set<string>(),
  weeklyOffs: [0], // Sunday only, matching every existing test's assumption
  priorLeaveEndDate: null,
  existingRanges: [],
  documentsRequired: false,
  documentRequiredAfterDays: null,
};

describe('checkLeaveRules', () => {
  it('a simple valid multi-day request passes and computes totalDays', () => {
    const result = checkLeaveRules(
      permissiveRules,
      {
        startDate: '2026-06-10',
        endDate: '2026-06-12',
        isHalfDay: false,
        hasAttachment: false,
      },
      baseContext,
    );
    expect(result.ok).toBe(true);
    expect(result.totalDays).toBe(3);
  });

  it('half-day requests are always 0.5 days', () => {
    const result = checkLeaveRules(
      permissiveRules,
      {
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        isHalfDay: true,
        hasAttachment: false,
      },
      baseContext,
    );
    expect(result.totalDays).toBe(0.5);
  });

  it('rejects half-day when allowHalfDay is false', () => {
    const rules = { ...permissiveRules, allowHalfDay: false };
    const result = checkLeaveRules(
      rules,
      {
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        isHalfDay: true,
        hasAttachment: false,
      },
      baseContext,
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'Half-day leave is not allowed for this leave type.',
    );
  });

  it('enforces minDurationDays', () => {
    const rules = { ...permissiveRules, minDurationDays: 2 };
    const result = checkLeaveRules(
      rules,
      {
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        isHalfDay: false,
        hasAttachment: false,
      },
      baseContext,
    );
    expect(result.ok).toBe(false);
  });

  it('enforces maxDurationDays', () => {
    const rules = { ...permissiveRules, maxDurationDays: 2 };
    const result = checkLeaveRules(
      rules,
      {
        startDate: '2026-06-10',
        endDate: '2026-06-13',
        isHalfDay: false,
        hasAttachment: false,
      },
      baseContext,
    );
    expect(result.ok).toBe(false);
  });

  it('enforces maxConsecutiveDays', () => {
    const rules = { ...permissiveRules, maxConsecutiveDays: 1 };
    const result = checkLeaveRules(
      rules,
      {
        startDate: '2026-06-10',
        endDate: '2026-06-11',
        isHalfDay: false,
        hasAttachment: false,
      },
      baseContext,
    );
    expect(result.ok).toBe(false);
  });

  describe('backdating', () => {
    it('rejects a backdated request when allowBackdated is false', () => {
      const rules = { ...permissiveRules, allowBackdated: false };
      const result = checkLeaveRules(
        rules,
        {
          startDate: '2026-05-01',
          endDate: '2026-05-01',
          isHalfDay: false,
          hasAttachment: false,
        },
        baseContext,
      );
      expect(result.ok).toBe(false);
    });

    it('rejects a backdated request beyond maxBackdateDays', () => {
      const rules = {
        ...permissiveRules,
        allowBackdated: true,
        maxBackdateDays: 5,
      };
      const result = checkLeaveRules(
        rules,
        {
          startDate: '2026-05-01',
          endDate: '2026-05-01',
          isHalfDay: false,
          hasAttachment: false,
        },
        baseContext,
      );
      expect(result.ok).toBe(false);
    });

    it('allows a backdated request within maxBackdateDays', () => {
      const rules = {
        ...permissiveRules,
        allowBackdated: true,
        maxBackdateDays: 60,
      };
      const result = checkLeaveRules(
        rules,
        {
          startDate: '2026-05-01',
          endDate: '2026-05-01',
          isHalfDay: false,
          hasAttachment: false,
        },
        baseContext,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('future-dating', () => {
    it('rejects a future request when allowFutureDated is false', () => {
      const rules = { ...permissiveRules, allowFutureDated: false };
      const result = checkLeaveRules(
        rules,
        {
          startDate: '2026-07-01',
          endDate: '2026-07-01',
          isHalfDay: false,
          hasAttachment: false,
        },
        baseContext,
      );
      expect(result.ok).toBe(false);
    });

    it('enforces noticePeriodDays', () => {
      const rules = { ...permissiveRules, noticePeriodDays: 10 };
      const result = checkLeaveRules(
        rules,
        {
          startDate: '2026-06-05',
          endDate: '2026-06-05',
          isHalfDay: false,
          hasAttachment: false,
        },
        baseContext,
      );
      expect(result.ok).toBe(false);
    });

    it('enforces maxAdvanceDays', () => {
      const rules = { ...permissiveRules, maxAdvanceDays: 5 };
      const result = checkLeaveRules(
        rules,
        {
          startDate: '2026-07-01',
          endDate: '2026-07-01',
          isHalfDay: false,
          hasAttachment: false,
        },
        baseContext,
      );
      expect(result.ok).toBe(false);
    });

    it('applying for today satisfies a zero notice period', () => {
      const result = checkLeaveRules(
        permissiveRules,
        {
          startDate: '2026-06-01',
          endDate: '2026-06-01',
          isHalfDay: false,
          hasAttachment: false,
        },
        baseContext,
      );
      expect(result.ok).toBe(true);
    });
  });

  it('enforces minGapBetweenRequestsDays against priorLeaveEndDate', () => {
    const rules = { ...permissiveRules, minGapBetweenRequestsDays: 5 };
    const context = { ...baseContext, priorLeaveEndDate: '2026-06-08' };
    const result = checkLeaveRules(
      rules,
      {
        startDate: '2026-06-10',
        endDate: '2026-06-11',
        isHalfDay: false,
        hasAttachment: false,
      },
      context,
    );
    expect(result.ok).toBe(false);
  });

  it('enforces restrictPrefixSuffixHoliday against the day before/after', () => {
    const rules = { ...permissiveRules, restrictPrefixSuffixHoliday: true };
    const context = { ...baseContext, holidayDates: new Set(['2026-06-09']) };
    const result = checkLeaveRules(
      rules,
      {
        startDate: '2026-06-10',
        endDate: '2026-06-11',
        isHalfDay: false,
        hasAttachment: false,
      },
      context,
    );
    expect(result.ok).toBe(false);
  });

  it('requires an attachment once the document threshold is crossed', () => {
    const context = {
      ...baseContext,
      documentsRequired: true,
      documentRequiredAfterDays: 2,
    };
    const withoutAttachment = checkLeaveRules(
      permissiveRules,
      {
        startDate: '2026-06-10',
        endDate: '2026-06-13',
        isHalfDay: false,
        hasAttachment: false,
      },
      context,
    );
    expect(withoutAttachment.ok).toBe(false);

    const withAttachment = checkLeaveRules(
      permissiveRules,
      {
        startDate: '2026-06-10',
        endDate: '2026-06-13',
        isHalfDay: false,
        hasAttachment: true,
      },
      context,
    );
    expect(withAttachment.ok).toBe(true);
  });

  it('rejects an overlapping request regardless of rules', () => {
    const context = {
      ...baseContext,
      existingRanges: [{ start: '2026-06-10', end: '2026-06-12' }],
    };
    const result = checkLeaveRules(
      permissiveRules,
      {
        startDate: '2026-06-11',
        endDate: '2026-06-15',
        isHalfDay: false,
        hasAttachment: false,
      },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'This leave request overlaps with an existing pending or approved leave.',
    );
  });

  describe('sandwich leave', () => {
    const sandwichRules = { ...permissiveRules, sandwichLeaveApplies: true };

    it('adds the gap into totalDays when every gap day is a holiday/Sunday', () => {
      // Prior leave ends 2026-06-05 (Fri). Gap day 2026-06-06 is a
      // Saturday (not counted as weekly-off) -- use a holiday instead.
      const context = {
        ...baseContext,
        priorLeaveEndDate: '2026-06-05',
        holidayDates: new Set(['2026-06-06']),
      };
      const result = checkLeaveRules(
        sandwichRules,
        {
          startDate: '2026-06-07',
          endDate: '2026-06-08',
          isHalfDay: false,
          hasAttachment: false,
        },
        context,
      );
      // 2 requested days + 1 gap day (the holiday between) = 3
      expect(result.totalDays).toBe(3);
    });

    it('adds a Saturday gap day for an org whose weekly-offs include Saturday (not just Sunday)', () => {
      // Same 2026-06-06 (Sat) gap as the "does not adjust" case below, but
      // this org's weeklyOffs is [0, 6] — Saturday is a real weekly-off
      // here, so the gap must fold in even with no holiday configured.
      const context = {
        ...baseContext,
        weeklyOffs: [0, 6],
        priorLeaveEndDate: '2026-06-05',
        holidayDates: new Set<string>(),
      };
      const result = checkLeaveRules(
        sandwichRules,
        {
          startDate: '2026-06-07',
          endDate: '2026-06-08',
          isHalfDay: false,
          hasAttachment: false,
        },
        context,
      );
      expect(result.totalDays).toBe(3);
    });

    it('does not adjust when the gap includes a working day', () => {
      const context = {
        ...baseContext,
        priorLeaveEndDate: '2026-06-05',
        holidayDates: new Set<string>(), // 06-06 is not a holiday or Sunday
      };
      const result = checkLeaveRules(
        sandwichRules,
        {
          startDate: '2026-06-07',
          endDate: '2026-06-08',
          isHalfDay: false,
          hasAttachment: false,
        },
        context,
      );
      expect(result.totalDays).toBe(2);
    });

    it('does not adjust half-day requests', () => {
      const context = {
        ...baseContext,
        priorLeaveEndDate: '2026-06-05',
        holidayDates: new Set(['2026-06-06']),
      };
      const result = checkLeaveRules(
        sandwichRules,
        {
          startDate: '2026-06-07',
          endDate: '2026-06-07',
          isHalfDay: true,
          hasAttachment: false,
        },
        context,
      );
      expect(result.totalDays).toBe(0.5);
    });
  });

  describe('request shape guards', () => {
    // Regression: isHalfDay short-circuited totalDays to 0.5 for ANY range
    // while approval still wrote HALF_DAY attendance across every date in
    // it — a month-long "half day" cost the employee 0.5 days of balance.
    it('rejects a half-day request spanning more than one date', () => {
      const result = checkLeaveRules(
        permissiveRules,
        {
          startDate: '2026-06-01',
          endDate: '2026-06-30',
          isHalfDay: true,
          hasAttachment: false,
        },
        baseContext,
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain('same date');
    });

    it('still allows a half-day request on a single date', () => {
      const result = checkLeaveRules(
        permissiveRules,
        {
          startDate: '2026-06-10',
          endDate: '2026-06-10',
          isHalfDay: true,
          hasAttachment: false,
        },
        baseContext,
      );
      expect(result.ok).toBe(true);
      expect(result.totalDays).toBe(0.5);
    });

    // countDaysInclusive would return a negative count, which then slips
    // past the balance check since a negative never exceeds available.
    it('rejects an end date before the start date', () => {
      const result = checkLeaveRules(
        permissiveRules,
        {
          startDate: '2026-06-12',
          endDate: '2026-06-10',
          isHalfDay: false,
          hasAttachment: false,
        },
        baseContext,
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain('End date cannot be before');
    });
  });
});

describe('effectiveLeaveRules', () => {
  const base: LeaveRules = {
    minDurationDays: 1,
    maxDurationDays: 90,
    noticePeriodDays: 30,
    allowBackdated: true,
    maxBackdateDays: 10,
    allowFutureDated: true,
    maxAdvanceDays: 60,
    allowHalfDay: false,
    sandwichLeaveApplies: true,
    restrictPrefixSuffixHoliday: true,
    maxConsecutiveDays: 20,
    minGapBetweenRequestsDays: 15,
  };

  it('leaves an annual type exactly as configured', () => {
    expect(effectiveLeaveRules(base, { allocationType: 'FIXED_ANNUAL' })).toBe(
      base,
    );
  });

  it('drops the inapplicable rules for an event-based type and counts calendar days', () => {
    const r = effectiveLeaveRules(base, {
      allocationType: 'EVENT_BASED',
      eventGrant: { unit: 'CALENDAR_DAYS' },
    });
    expect(r.minGapBetweenRequestsDays).toBe(0);
    expect(r.maxConsecutiveDays).toBeNull();
    expect(r.maxAdvanceDays).toBeNull();
    expect(r.sandwichLeaveApplies).toBe(false);
    expect(r.restrictPrefixSuffixHoliday).toBe(false);
    expect(r.countCalendarDays).toBe(true);
    // The rules that still apply are untouched.
    expect(r.noticePeriodDays).toBe(30);
    expect(r.minDurationDays).toBe(1);
    expect(r.maxDurationDays).toBe(90);
  });

  it('keeps sandwich / prefix-suffix in working days', () => {
    const r = effectiveLeaveRules(base, {
      allocationType: 'EVENT_BASED',
      eventGrant: { unit: 'WORKING_DAYS' },
    });
    expect(r.sandwichLeaveApplies).toBe(true);
    expect(r.restrictPrefixSuffixHoliday).toBe(true);
    expect(r.countCalendarDays).toBeUndefined();
    expect(r.minGapBetweenRequestsDays).toBe(0);
  });
});

describe('applicationDocumentRule', () => {
  it('keeps the document rule of an annual type', () => {
    expect(
      applicationDocumentRule({
        allocationType: 'FIXED_ANNUAL',
        documentsRequired: true,
        documentRequiredAfterDays: 2,
      }),
    ).toEqual({ documentsRequired: true, documentRequiredAfterDays: 2 });
  });
  it('does not ask again when the grant already carries the document', () => {
    expect(
      applicationDocumentRule(
        {
          allocationType: 'EVENT_BASED',
          documentsRequired: true,
          documentRequiredAfterDays: null,
        },
        { grantHasDocument: true },
      ),
    ).toEqual({ documentsRequired: false, documentRequiredAfterDays: null });
  });

  it('asks for the document when the type requires one and no grant carries it', () => {
    expect(
      applicationDocumentRule({
        allocationType: 'EVENT_BASED',
        documentsRequired: true,
        documentRequiredAfterDays: 3,
      }),
    ).toEqual({ documentsRequired: true, documentRequiredAfterDays: null });
  });
});

describe('half-day on a day off', () => {
  const rules = {
    minDurationDays: 0.5,
    maxDurationDays: null,
    noticePeriodDays: 0,
    allowBackdated: true,
    maxBackdateDays: 30,
    allowFutureDated: true,
    maxAdvanceDays: null,
    allowHalfDay: true,
    sandwichLeaveApplies: false,
    restrictPrefixSuffixHoliday: false,
    maxConsecutiveDays: null,
    minGapBetweenRequestsDays: 0,
  };
  const ctx = (holidays: string[] = []) => ({
    today: '2026-06-10',
    holidayDates: new Set(holidays),
    weeklyOffs: [0] as never,
    existingRanges: [],
    documentsRequired: false,
    documentRequiredAfterDays: null,
  });
  const half = (d: string) => ({
    startDate: d,
    endDate: d,
    isHalfDay: true,
    halfDaySession: 'FIRST_HALF',
    hasAttachment: false,
  });

  it('is refused on a Sunday and on a holiday, accepted on a working day', () => {
    expect(checkLeaveRules(rules, half('2026-06-14'), ctx()).ok).toBe(false); // Sunday
    expect(
      checkLeaveRules(rules, half('2026-06-16'), ctx(['2026-06-16'])).ok,
    ).toBe(false);
    expect(checkLeaveRules(rules, half('2026-06-16'), ctx()).ok).toBe(true);
  });

  it('is accepted on a weekly off for calendar-day (event) leave', () => {
    expect(
      checkLeaveRules(
        { ...rules, countCalendarDays: true },
        half('2026-06-14'),
        ctx(),
      ).ok,
    ).toBe(true);
  });
});

describe('rangesOverlap with half-day sessions', () => {
  const d = '2026-06-16';
  const h = (session: string | null, over: object = {}) => ({
    start: d,
    end: d,
    isHalfDay: true,
    halfDaySession: session,
    ...over,
  });
  it('different sessions on one date do not overlap', () => {
    expect(rangesOverlap(h('FIRST_HALF'), h('SECOND_HALF'))).toBe(false);
  });
  it('the same session, a missing session, or a full day still overlaps', () => {
    expect(rangesOverlap(h('FIRST_HALF'), h('FIRST_HALF'))).toBe(true);
    expect(rangesOverlap(h(null), h('SECOND_HALF'))).toBe(true);
    expect(
      rangesOverlap(h('FIRST_HALF'), { start: d, end: d, isHalfDay: false }),
    ).toBe(true);
    expect(
      rangesOverlap(h('FIRST_HALF'), h('SECOND_HALF', { end: '2026-06-17' })),
    ).toBe(true);
  });
});

describe('splitDaysByYear', () => {
  const rules = { sandwichLeaveApplies: false, countCalendarDays: false };
  it('is a single part for a leave inside one year', () => {
    expect(
      splitDaysByYear(rules, '2026-12-01', '2026-12-04', 4, new Set(), [0]),
    ).toEqual([{ year: 2026, days: 4 }]);
  });
  it('splits working days at New Year and adds back to the total', () => {
    // Mon 30 Dec 2030 .. Thu 2 Jan 2031; Sunday is the only weekly off.
    expect(
      splitDaysByYear(rules, '2030-12-30', '2031-01-02', 4, new Set(), [0]),
    ).toEqual([
      { year: 2030, days: 2 },
      { year: 2031, days: 2 },
    ]);
  });
  it('a sandwich-adjusted total keeps the parts summing to it (remainder on the last year)', () => {
    const parts = splitDaysByYear(
      { sandwichLeaveApplies: true, countCalendarDays: false },
      '2030-12-30',
      '2031-01-02',
      6,
      new Set(),
      [0],
    );
    expect(parts.reduce((s, p) => s + p.days, 0)).toBe(6);
    expect(parts[0].year).toBe(2030);
  });
});
