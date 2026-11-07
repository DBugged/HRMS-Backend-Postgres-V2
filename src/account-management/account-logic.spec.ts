import {
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
