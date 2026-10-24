import { BadRequestException } from '@nestjs/common';
import { validateCouponInput, validateInvoiceInput, validatePaymentInput, validatePlanInput, validateRefundInput } from './cc-validation';

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
    expect(() => validateCouponInput({ type: 'FIXED', value: 500 })).not.toThrow();
  });
  it.each([{ type: 'PERCENT', value: 150 }, { type: 'FIXED', value: -5 }, { type: 'FIXED', value: 0 }, { type: 'MAGIC', value: 5 }, { status: 'WEIRD' }, { maxRedemptions: 0 }, { validFrom: new Date('2027-02-01'), validUntil: new Date('2027-01-01') }])('rejects %j', (d) => {
    expect(() => validateCouponInput(d)).toThrow(BadRequestException);
  });
});
