import { BadRequestException } from '@nestjs/common';
import {
  requireReason, validateAdminInput, validateAnnouncementInput, validateCouponInput, validateFlagOverrideValue, validateInvoiceInput, validateOrgCreate,
  validateOrgUpdate, validatePaymentInput, validatePlanInput, validateRefundInput, validateSettingValue, validateTicketInput,
} from './cc-validation';

const line = (over: Record<string, unknown> = {}) => ({ description: 'Starter, 10 employees', quantity: 1, unitAmount: 1000, ...over });

describe('validateInvoiceInput', () => {
  it('accepts an ordinary invoice', () => {
    expect(() => validateInvoiceInput({ lineItems: [line()], dueDate: '2027-01-31' })).not.toThrow();
  });
  it.each([
    ['no lines', { lineItems: [] }],
    ['a negative amount', { lineItems: [line({ unitAmount: -5 })] }],
    ['a zero quantity', { lineItems: [line({ quantity: 0 })] }],
    ['a non-numeric amount', { lineItems: [line({ unitAmount: 'abc' })] }],
    ['NaN', { lineItems: [line({ unitAmount: NaN })] }],
    ['three decimal places', { lineItems: [line({ unitAmount: 10.123 })] }],
    ['an empty description', { lineItems: [line({ description: ' ' })] }],
    ['a zero total', { lineItems: [line({ unitAmount: 0 })] }],
    ['an invalid due date', { lineItems: [line()], dueDate: 'not-a-date' }],
  ])('rejects %s', (_n, body) => {
    expect(() => validateInvoiceInput(body)).toThrow(BadRequestException);
  });
});

describe('validatePaymentInput / validateRefundInput', () => {
  const pay = { amount: 500, provider: 'UPI', providerRef: 'UTR123', currency: 'INR' };
  it('accepts a normal payment', () => expect(() => validatePaymentInput(pay)).not.toThrow());
  it.each([{ amount: 0 }, { amount: -1 }, { amount: '5' }, { providerRef: '' }, { provider: '' }, { currency: 'rupees' }, { last4: '12' }])('rejects %j', (over) => {
    expect(() => validatePaymentInput({ ...pay, ...over })).toThrow(BadRequestException);
  });
  it('a refund needs a positive amount and a reason', () => {
    expect(() => validateRefundInput({ amount: 10, reason: 'duplicate' })).not.toThrow();
    expect(() => validateRefundInput({ amount: 10, reason: '' })).toThrow(BadRequestException);
    expect(() => validateRefundInput({ amount: -10, reason: 'x' })).toThrow(BadRequestException);
  });
});

describe('validatePlanInput', () => {
  it('accepts sensible values and ignores fields not sent', () => {
    expect(() => validatePlanInput({ name: 'Starter', code: 'STARTER', perEmployeeRate: 50, trialDays: 14, includedEmployees: 25, status: 'ACTIVE' })).not.toThrow();
    expect(() => validatePlanInput({ perEmployeeRate: null })).not.toThrow();
  });
  it.each([{ perEmployeeRate: -1 }, { trialDays: 4000 }, { includedEmployees: 0 }, { status: 'WHATEVER' }, { code: 'a b' }, { basePrice: 'x' }])('rejects %j', (d) => {
    expect(() => validatePlanInput(d)).toThrow(BadRequestException);
  });
});

describe('validateCouponInput', () => {
  it('accepts a percent and a fixed coupon', () => {
    expect(() => validateCouponInput({ type: 'PERCENT', value: 20, status: 'ACTIVE' })).not.toThrow();
    expect(() => validateCouponInput({ type: 'FIXED', value: 500, currency: 'INR' })).not.toThrow();
  });
  it.each([{ type: 'PERCENT', value: 150 }, { type: 'FIXED', value: -5 }, { type: 'FIXED', value: 0 }, { type: 'MAGIC', value: 5 }, { status: 'WEIRD' }, { maxRedemptions: 0 }, { validFrom: new Date('2027-02-01'), validUntil: new Date('2027-01-01') }])('rejects %j', (d) => {
    expect(() => validateCouponInput(d)).toThrow(BadRequestException);
  });
});

describe('QA hardening validators', () => {
  it('requires a reason of at least 3 characters', () => {
    expect(requireReason('  Duplicate signup ', 'suspending')).toBe('Duplicate signup');
    expect(() => requireReason('', 'suspending')).toThrow(BadRequestException);
    expect(() => requireReason('ab', 'suspending')).toThrow(BadRequestException);
    expect(() => requireReason(undefined, 'suspending')).toThrow(BadRequestException);
  });
  it('checks a new company', () => {
    expect(() => validateOrgCreate({ name: 'Acme', adminName: 'Asha', adminEmail: 'asha@acme.com' })).not.toThrow();
    expect(() => validateOrgCreate({ name: 'A', adminName: 'Asha', adminEmail: 'asha@acme.com' })).toThrow(BadRequestException);
    expect(() => validateOrgCreate({ name: 'Acme', adminName: 'Asha', adminEmail: 'not-an-email' })).toThrow(BadRequestException);
  });
  it.each([{ billingEmail: 'x' }, { phone: 'abc' }, { gstin: '123' }, { name: 'x'.repeat(300) }])('rejects company edit %j', (b) => {
    expect(() => validateOrgUpdate(b)).toThrow(BadRequestException);
  });
  it('accepts a valid GSTIN and blank optional fields', () => {
    expect(() => validateOrgUpdate({ gstin: '27ABCDE1234F1Z5', phone: '+91 98765 43210', billingEmail: '' })).not.toThrow();
  });
  it('rejects an unknown admin role', () => {
    expect(() => validateAdminInput({ email: 'a@b.com', name: 'A', role: 'KING' })).toThrow(BadRequestException);
    expect(() => validateAdminInput({ role: 'KING' }, true)).toThrow(BadRequestException);
    expect(() => validateAdminInput({ email: 'a@b.com', name: 'A', role: 'SUPPORT' })).not.toThrow();
  });
  it('rejects a bad ticket priority', () => {
    expect(() => validateTicketInput({ subject: 's', body: 'b', priority: 'WHENEVER' })).toThrow(BadRequestException);
  });
  it.each([
    { title: 't', body: 'b', audience: 'ORG' },
    { title: 't', body: 'b', audience: 'PLAN' },
    { title: 't', body: 'b', severity: 'LOUD' },
    { title: 't', body: 'b', startsAt: '2027-02-01', endsAt: '2027-01-01' },
  ])('rejects announcement %j', (b) => {
    expect(() => validateAnnouncementInput(b, true)).toThrow(BadRequestException);
  });
  it('limits settings', () => {
    expect(() => validateSettingValue('billing.auto_suspend_days', 'number', -1)).toThrow(BadRequestException);
    expect(() => validateSettingValue('billing.auto_suspend_days', 'number', 1e12)).toThrow(BadRequestException);
    expect(() => validateSettingValue('billing.auto_suspend_days', 'number', 7)).not.toThrow();
    expect(() => validateSettingValue('support.email', 'string', '<script>')).toThrow(BadRequestException);
    expect(() => validateSettingValue('support.email', 'string', 'help@x.com')).not.toThrow();
  });
  it('accepts only plain override values', () => {
    expect(() => validateFlagOverrideValue(null)).toThrow(BadRequestException);
    expect(() => validateFlagOverrideValue({ enabled: true })).toThrow(BadRequestException);
    expect(() => validateFlagOverrideValue(true)).not.toThrow();
  });
  it('coupon code, currency and plan list rules', () => {
    expect(() => validateCouponInput({ code: 'SAVE<10>' })).toThrow(BadRequestException);
    expect(() => validateCouponInput({ code: 'A'.repeat(200) })).toThrow(BadRequestException);
    expect(() => validateCouponInput({ code: 'SAVE10', type: 'FIXED', value: 5 })).toThrow(BadRequestException);
    expect(() => validateCouponInput({ code: 'SAVE10', type: 'FIXED', value: 5, currency: 'INR' })).not.toThrow();
  });
  it('plan features must be a list of text', () => {
    expect(() => validatePlanInput({ features: 'all' })).toThrow(BadRequestException);
    expect(() => validatePlanInput({ features: ['a', 'b'] })).not.toThrow();
  });
  it('invoice due date cannot be in the past', () => {
    expect(() => validateInvoiceInput({ lineItems: [line()], dueDate: '2020-01-01' })).toThrow(BadRequestException);
    expect(() => validateInvoiceInput({ lineItems: [line()], dueDate: '2099-01-01' })).not.toThrow();
  });
});
