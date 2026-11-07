import {
  effectiveDay,
  headcountTrend,
  scheduleDue,
  accountNotices,
  reminderTier,
  deriveSubscriptionStatus,
  limitLevel,
  normalizeTicketStatus,
} from './account-logic';

const now = new Date('2026-11-10T00:00:00Z');
const in_ = (days: number) => new Date(now.getTime() + days * 86_400_000);

describe('deriveSubscriptionStatus', () => {
  it('is null with no subscription, and Suspended whatever the subscription says', () => {
    expect(deriveSubscriptionStatus(null, 'ACTIVE', now)).toBeNull();
    expect(
      deriveSubscriptionStatus(
        { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: in_(200) },
        'SUSPENDED',
        now,
      ),
    ).toBe('SUSPENDED');
  });
  it('maps the stored statuses', () => {
    const base = { trialEndsAt: null, currentPeriodEnd: in_(200) };
    expect(
      deriveSubscriptionStatus({ ...base, status: 'CANCELED' }, 'ACTIVE', now),
    ).toBe('CANCELLED');
    expect(
      deriveSubscriptionStatus({ ...base, status: 'EXPIRED' }, 'ACTIVE', now),
    ).toBe('EXPIRED');
    expect(
      deriveSubscriptionStatus({ ...base, status: 'PAST_DUE' }, 'ACTIVE', now),
    ).toBe('PAYMENT_PENDING');
    expect(
      deriveSubscriptionStatus({ ...base, status: 'ACTIVE' }, 'ACTIVE', now),
    ).toBe('ACTIVE');
  });
  it('reads a trial as Trial until it ends, then Expired', () => {
    expect(
      deriveSubscriptionStatus(
        { status: 'TRIALING', trialEndsAt: in_(5), currentPeriodEnd: null },
        'ACTIVE',
        now,
      ),
    ).toBe('TRIAL');
    expect(
      deriveSubscriptionStatus(
        { status: 'TRIALING', trialEndsAt: in_(-1), currentPeriodEnd: null },
        'ACTIVE',
        now,
      ),
    ).toBe('EXPIRED');
  });
  it('reads a paid period that is ending within 30 days as Expiring Soon, and one that has ended as Expired', () => {
    expect(
      deriveSubscriptionStatus(
        { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: in_(30) },
        'ACTIVE',
        now,
      ),
    ).toBe('EXPIRING_SOON');
    expect(
      deriveSubscriptionStatus(
        { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: in_(31) },
        'ACTIVE',
        now,
      ),
    ).toBe('ACTIVE');
    expect(
      deriveSubscriptionStatus(
        { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: in_(-1) },
        'ACTIVE',
        now,
      ),
    ).toBe('EXPIRED');
  });
});

describe('limitLevel', () => {
  it('has no limit when none is set', () => {
    expect(limitLevel(50, null)).toBe('NO_LIMIT');
    expect(limitLevel(50, 0)).toBe('NO_LIMIT');
  });
  it('warns from 80% and stops at the limit', () => {
    expect(limitLevel(79, 100)).toBe('OK');
    expect(limitLevel(80, 100)).toBe('APPROACHING');
    expect(limitLevel(100, 100)).toBe('REACHED');
    expect(limitLevel(120, 100)).toBe('REACHED');
  });
});

describe('normalizeTicketStatus', () => {
  it('reads the legacy Pending as In Progress', () => {
    expect(normalizeTicketStatus('PENDING')).toBe('IN_PROGRESS');
    expect(normalizeTicketStatus('OPEN')).toBe('OPEN');
  });
});

describe('account notices', () => {
  const now = new Date('2026-11-07T00:00:00Z');
  const plus = (d: number) => new Date(now.getTime() + d * 86_400_000);
  it('warns before an expiry, after it, and about overdue invoices', () => {
    expect(accountNotices('EXPIRING_SOON', plus(10), false, [], now)[0]).toMatchObject({ level: 'warning', code: 'EXPIRING' });
    expect(accountNotices('EXPIRED', plus(-2), false, [], now)[0]).toMatchObject({ level: 'danger', code: 'EXPIRED' });
    expect(accountNotices('ACTIVE', plus(200), false, [{ number: 'I1', total: 100, currency: 'INR' }], now)[0]).toMatchObject({ code: 'OVERDUE' });
    expect(accountNotices('ACTIVE', plus(200), false, [], now)).toEqual([]);
    expect(accountNotices('TRIAL', plus(3), false, [], now)[0].code).toBe('TRIAL_ENDING');
    expect(accountNotices('TRIAL', plus(20), false, [], now)).toEqual([]);
  });
  it('picks the one-time reminder tier', () => {
    expect([plus(60), plus(20), plus(5), plus(0.5), plus(-1)].map((d) => reminderTier(d, now))).toEqual([null, 30, 7, 1, 0]);
    expect(reminderTier(null, now)).toBeNull();
  });
});

describe('headcountTrend and scheduleDue', () => {
  const now = new Date('2026-11-15T10:00:00Z');
  const p = (join: string, over: { isActive?: boolean; exitDate?: string | null; updatedAt?: string } = {}) => ({ joiningDate: new Date(join), isActive: over.isActive ?? true, exitDate: over.exitDate ?? null, updatedAt: new Date(over.updatedAt ?? '2026-11-01T00:00:00Z') });
  it('counts people from joining to last working day, six months', () => {
    const trend = headcountTrend([p('2026-01-01'), p('2026-09-10'), p('2026-05-01', { isActive: false, exitDate: '2026-09-30' }), p('2026-06-01', { isActive: false, updatedAt: '2026-10-05T00:00:00Z' })], 6, now);
    expect(trend.map((t) => t.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(trend.map((t) => t.headcount)).toEqual([3, 3, 3, 4, 2, 2]);
  });
  it('runs a monthly schedule once its day has come and not twice in a month', () => {
    expect(scheduleDue(10, null, now)).toBe(true);
    expect(scheduleDue(20, null, now)).toBe(false);
    expect(scheduleDue(10, new Date('2026-11-10T03:00:00Z'), now)).toBe(false);
    expect(scheduleDue(10, new Date('2026-10-10T03:00:00Z'), now)).toBe(true);
  });
});

describe('schedules on days a month does not have', () => {
  it('runs on the last day of a shorter month', () => {
    expect(effectiveDay(31, new Date('2026-02-10T00:00:00Z'))).toBe(28);
    expect(effectiveDay(31, new Date('2028-02-10T00:00:00Z'))).toBe(29);
    expect(effectiveDay(31, new Date('2026-04-10T00:00:00Z'))).toBe(30);
    expect(effectiveDay(30, new Date('2026-01-10T00:00:00Z'))).toBe(30);
    expect(effectiveDay(15, new Date('2026-02-10T00:00:00Z'))).toBe(15);
  });
  it('is due on the 28th of February for day 31, not before, and not twice', () => {
    expect(scheduleDue(31, null, new Date('2026-02-27T03:00:00Z'))).toBe(false);
    expect(scheduleDue(31, null, new Date('2026-02-28T03:00:00Z'))).toBe(true);
    expect(scheduleDue(31, new Date('2026-02-28T03:00:00Z'), new Date('2026-02-28T04:00:00Z'))).toBe(false);
    expect(scheduleDue(31, new Date('2026-01-31T03:00:00Z'), new Date('2026-02-28T03:00:00Z'))).toBe(true);
  });
});
