import { AllocationType } from '@prisma/client';
import { computeUpfrontCredit } from '../leave-balances/leave-balance-math';
import {
  checkGrantRequest,
  readEventGrantConfig,
  type GrantRuleType,
} from './leave-grant-rules';

const type = (over: Partial<GrantRuleType> = {}): GrantRuleType => ({
  isActive: true,
  allocationType: AllocationType.EVENT_BASED,
  annualQuota: 182,
  documentsRequired: false,
  eventGrant: { unit: 'CALENDAR_DAYS', repeatPolicy: 'ONCE_PER_EVENT' },
  ...over,
});
const req = (over = {}) => ({
  eventDate: '2026-10-01',
  effectiveDate: '2026-10-01',
  days: 182,
  ...over,
});

describe('checkGrantRequest', () => {
  it('accepts a valid grant up to the policy maximum', () => {
    expect(checkGrantRequest(type(), req(), [])).toBeNull();
    expect(checkGrantRequest(type(), req({ days: 90 }), [])).toBeNull();
  });

  it('rejects annual types, inactive types and bad amounts', () => {
    expect(
      checkGrantRequest(
        type({ allocationType: AllocationType.FIXED_ANNUAL }),
        req(),
        [],
      ),
    ).toMatch(/not event-based/);
    expect(checkGrantRequest(type({ isActive: false }), req(), [])).toMatch(
      /inactive/,
    );
    expect(checkGrantRequest(type(), req({ days: 0 }), [])).toMatch(
      /more than zero/,
    );
    expect(checkGrantRequest(type(), req({ days: 183 }), [])).toMatch(
      /cannot exceed/,
    );
  });

  it('requires the supporting confirmation when the type asks for it', () => {
    expect(
      checkGrantRequest(type({ documentsRequired: true }), req(), []),
    ).toMatch(/required/);
    expect(
      checkGrantRequest(
        type({ documentsRequired: true }),
        req({ documentRef: 'cert-1' }),
        [],
      ),
    ).toBeNull();
  });

  it('blocks a second grant for the same event date', () => {
    expect(checkGrantRequest(type(), req(), ['2026-10-01'])).toMatch(
      /already exists/,
    );
    expect(checkGrantRequest(type(), req(), ['2024-03-01'])).toBeNull();
  });

  it('enforces the minimum interval between events when configured', () => {
    const t = type({
      eventGrant: { repeatPolicy: 'MIN_INTERVAL', minIntervalDays: 365 },
    });
    expect(
      checkGrantRequest(t, req({ eventDate: '2026-10-01' }), ['2026-03-01']),
    ).toMatch(/apart/);
    expect(
      checkGrantRequest(t, req({ eventDate: '2026-10-01' }), ['2025-03-01']),
    ).toBeNull();
  });

  it('reads a legacy months setting as 30-day months', () => {
    expect(
      readEventGrantConfig({
        repeatPolicy: 'MIN_INTERVAL',
        minIntervalMonths: 2,
      }).minIntervalDays,
    ).toBe(60);
  });

  it('honours the effective-from date', () => {
    const t = type({ eventGrant: { effectiveFrom: '2027-01-01' } });
    expect(checkGrantRequest(t, req(), [])).toMatch(/from 2027-01-01/);
  });
});

describe('event-based balance behaviour', () => {
  it('is never credited by the yearly upfront rule', () => {
    expect(
      computeUpfrontCredit(
        {
          allocationType: AllocationType.EVENT_BASED,
          annualQuota: 182,
          prorateOnJoining: false,
        },
        new Date('2020-01-01'),
        2027,
      ),
    ).toBe(0);
  });

  it('keeps annual types on the upfront credit', () => {
    expect(
      computeUpfrontCredit(
        {
          allocationType: AllocationType.FIXED_ANNUAL,
          annualQuota: 12,
          prorateOnJoining: false,
        },
        new Date('2020-01-01'),
        2027,
      ),
    ).toBe(12);
  });

  it('defaults the grant settings to calendar days, once per event', () => {
    expect(readEventGrantConfig({})).toEqual({
      unit: 'CALENDAR_DAYS',
      repeatPolicy: 'ONCE_PER_EVENT',
      minIntervalDays: 0,
      effectiveFrom: null,
    });
  });
});
