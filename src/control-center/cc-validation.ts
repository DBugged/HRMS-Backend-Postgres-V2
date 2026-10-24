// Purpose: input checks for the Control Panel's money-related writes (invoices, payments, plans, coupons), kept pure so
//   they can be tested without a database. Each function throws a BadRequestException with a message written for the admin.
// Important: these only reject values that could never be right (negative or non-numeric money, unknown statuses, bad
//   dates); business rules that need the database (an invoice already paid, a duplicate reference) stay in the services.
import { BadRequestException } from '@nestjs/common';

const bad = (message: string): never => {
  throw new BadRequestException(message);
};
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const money = (v: unknown, label: string, { min = 0, allowZero = true }: { min?: number; allowZero?: boolean } = {}) => {
  if (!isNum(v)) bad(`${label} must be a number.`);
  const n = v as number;
  if (n < min || (!allowZero && n === min)) bad(`${label} must be ${allowZero ? 'zero or more' : 'more than zero'}.`);
  if (n > 1e9) bad(`${label} is too large.`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) bad(`${label} can have at most 2 decimal places.`);
};
const wholeNumber = (v: unknown, label: string, min: number, max: number) => {
  if (!isNum(v) || !Number.isInteger(v) || v < min || v > max) bad(`${label} must be a whole number from ${min} to ${max}.`);
};
const text = (v: unknown, label: string, max: number) => {
  if (typeof v !== 'string' || !v.trim()) bad(`${label} is required.`);
  if ((v as string).length > max) bad(`${label} can be at most ${max} characters.`);
};
const validDate = (v: unknown, label: string): Date => {
  const d = new Date(v as string);
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) bad(`${label} is not a valid date.`);
  return d;
};

export function validateInvoiceInput(b: { lineItems?: unknown; dueDate?: unknown; couponCode?: unknown }): void {
  if (!Array.isArray(b.lineItems) || b.lineItems.length === 0) bad('Add at least one line item.');
  const lines = b.lineItems as Record<string, unknown>[];
  if (lines.length > 50) bad('An invoice can have at most 50 line items.');
  lines.forEach((l, i) => {
    text(l?.description, `Line ${i + 1} description`, 200);
    money(l?.quantity, `Line ${i + 1} quantity`, { allowZero: false });
    money(l?.unitAmount, `Line ${i + 1} amount`);
  });
  const subtotal = lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unitAmount), 0);
  if (!(subtotal > 0)) bad('The invoice total must be more than zero.');
  if (b.dueDate !== undefined && b.dueDate !== null && b.dueDate !== '') validDate(b.dueDate, 'The due date');
  if (b.couponCode !== undefined && b.couponCode !== null && typeof b.couponCode !== 'string') bad('The coupon code must be text.');
}

export function validatePaymentInput(b: { amount?: unknown; currency?: unknown; provider?: unknown; providerRef?: unknown; last4?: unknown }): void {
  money(b.amount, 'The amount', { allowZero: false });
  text(b.provider, 'The payment provider', 50);
  text(b.providerRef, 'The payment reference', 100);
  if (b.currency !== undefined && b.currency !== null && !/^[A-Z]{3}$/.test(String(b.currency))) bad('The currency must be a 3-letter code such as INR.');
  if (b.last4 !== undefined && b.last4 !== null && !/^\d{4}$/.test(String(b.last4))) bad('last4 must be 4 digits.');
}

export function validateRefundInput(b: { amount?: unknown; reason?: unknown }): void {
  money(b?.amount, 'The refund amount', { allowZero: false });
  text(b?.reason, 'The refund reason', 500);
}

const PLAN_STATUSES = ['ACTIVE', 'DEPRECATED', 'DRAFT'];
const BILLING_MODELS = ['PER_EMPLOYEE', 'FIXED_TERM'];
export function validatePlanInput(d: Record<string, unknown>): void {
  if ('code' in d && !/^[a-z0-9][a-z0-9_-]{1,39}$/i.test(String(d.code ?? ''))) bad('The plan code must be 2-40 letters, numbers, dashes or underscores.');
  if ('name' in d) text(d.name, 'The plan name', 100);
  for (const k of ['perEmployeeRate', 'perExtraEmployeeRate', 'basePrice'] as const) if (k in d && d[k] != null) money(d[k], k);
  if ('trialDays' in d && d.trialDays != null) wholeNumber(d.trialDays, 'Trial days', 0, 365);
  for (const k of ['includedEmployees', 'seatLimit', 'termMonths'] as const) if (k in d && d[k] != null) wholeNumber(d[k], k, 1, 100000);
  if ('status' in d && !PLAN_STATUSES.includes(String(d.status))) bad(`The plan status must be one of: ${PLAN_STATUSES.join(', ')}.`);
  if ('billingModel' in d && !BILLING_MODELS.includes(String(d.billingModel))) bad(`The billing model must be one of: ${BILLING_MODELS.join(', ')}.`);
  if ('currency' in d && !/^[A-Z]{3}$/.test(String(d.currency))) bad('The currency must be a 3-letter code such as INR.');
}

const COUPON_TYPES = ['PERCENT', 'FIXED'];
const COUPON_STATUSES = ['ACTIVE', 'INACTIVE', 'EXPIRED'];
export function validateCouponInput(d: Record<string, unknown>): void {
  if ('type' in d && !COUPON_TYPES.includes(String(d.type))) bad(`The coupon type must be one of: ${COUPON_TYPES.join(', ')}.`);
  if ('value' in d) {
    money(Number(d.value), 'The coupon value', { allowZero: false });
    if (d.type === 'PERCENT' && Number(d.value) > 100) bad('A percentage cannot be more than 100.');
  }
  if ('status' in d && !COUPON_STATUSES.includes(String(d.status))) bad(`The coupon status must be one of: ${COUPON_STATUSES.join(', ')}.`);
  for (const k of ['maxRedemptions', 'perOrgLimit'] as const) if (k in d && d[k] != null) wholeNumber(d[k], k, 1, 1_000_000);
  if ('currency' in d && d.currency != null && !/^[A-Z]{3}$/.test(String(d.currency))) bad('The currency must be a 3-letter code such as INR.');
  const from = d.validFrom instanceof Date ? d.validFrom : null;
  const until = d.validUntil instanceof Date ? d.validUntil : null;
  if ((from && Number.isNaN(from.getTime())) || (until && Number.isNaN(until.getTime()))) bad('A coupon date is not valid.');
  if (from && until && until < from) bad('The coupon cannot end before it starts.');
}
