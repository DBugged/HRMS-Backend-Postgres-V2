import { checkLeaveRules, LeaveRules } from './leave-rules';

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
});
