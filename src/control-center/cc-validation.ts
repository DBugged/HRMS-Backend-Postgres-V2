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
  if (b.dueDate !== undefined && b.dueDate !== null && b.dueDate !== '') {
    const due = validDate(b.dueDate, 'The due date');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (due < today) bad('The due date cannot be in the past.');
  }
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
  if ('features' in d && d.features != null && (!Array.isArray(d.features) || d.features.some((f) => typeof f !== 'string'))) bad('Plan features must be a list of text lines.');
  if ('status' in d && !PLAN_STATUSES.includes(String(d.status))) bad(`The plan status must be one of: ${PLAN_STATUSES.join(', ')}.`);
  if ('billingModel' in d && !BILLING_MODELS.includes(String(d.billingModel))) bad(`The billing model must be one of: ${BILLING_MODELS.join(', ')}.`);
  if ('currency' in d && !/^[A-Z]{3}$/.test(String(d.currency))) bad('The currency must be a 3-letter code such as INR.');
}

const COUPON_TYPES = ['PERCENT', 'FIXED'];
const COUPON_STATUSES = ['ACTIVE', 'INACTIVE', 'EXPIRED'];
export function validateCouponInput(d: Record<string, unknown>): void {
  if ('code' in d && !/^[A-Z0-9_-]{3,40}$/.test(String(d.code ?? ''))) bad('The coupon code must be 3-40 letters, numbers, dashes or underscores.');
  if (d.type === 'FIXED' && !d.currency) bad('A fixed-amount coupon needs a currency such as INR.');
  if ('appliesToPlanIds' in d && d.appliesToPlanIds != null && (!Array.isArray(d.appliesToPlanIds) || d.appliesToPlanIds.some((x) => typeof x !== 'string'))) bad('Plans must be a list of plan ids.');
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

// ---- Shared checks for the Control Panel's other writes (added after a QA pass: each rejected value used to be saved) ----
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isEmail = (v: unknown): boolean => typeof v === 'string' && v.trim().length <= 254 && EMAIL.test(v.trim());

/** A reason given for a decision (reject, suspend, archive): required, so the audit log always says why. */
export function requireReason(reason: unknown, action: string): string {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (r.length < 3) bad(`Say why you are ${action} (at least 3 characters).`);
  if (r.length > 500) bad('The reason can be at most 500 characters.');
  return r;
}

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PHONE = /^[+()\-\s\d]{7,20}$/;

/** Creating a company from the Control Panel: company name, first admin and (optionally) their email. */
export function validateOrgCreate(b: { name?: unknown; adminName?: unknown; adminEmail?: unknown }): void {
  text(b.name, 'The company name', 200);
  if (String(b.name).trim().length < 2) bad('The company name must be at least 2 characters.');
  text(b.adminName, 'The admin name', 100);
  if (!isEmail(b.adminEmail)) bad('Enter a valid admin email address.');
}

/** Editing a company: only the fields that are sent are checked. */
export function validateOrgUpdate(b: Record<string, unknown>): void {
  if ('name' in b && b.name != null && String(b.name).trim() !== '') text(b.name, 'The company name', 200);
  if ('billingEmail' in b && String(b.billingEmail ?? '').trim() !== '' && !isEmail(b.billingEmail)) bad('Enter a valid billing email address.');
  if ('phone' in b && String(b.phone ?? '').trim() !== '' && !PHONE.test(String(b.phone).trim())) bad('Enter a valid phone number (digits, +, spaces and dashes).');
  if ('gstin' in b && String(b.gstin ?? '').trim() !== '' && !GSTIN.test(String(b.gstin).trim().toUpperCase())) bad('Enter a valid 15-character GSTIN, for example 27ABCDE1234F1Z5.');
  for (const k of ['city', 'state', 'country'] as const) if (k in b && b[k] != null && String(b[k]).length > 100) bad(`The ${k} can be at most 100 characters.`);
}

const ADMIN_ROLES = ['OWNER', 'ADMIN', 'SUPPORT', 'BILLING', 'READ_ONLY'];
export function validateAdminInput(b: { email?: unknown; name?: unknown; role?: unknown }, partial = false): void {
  if (!partial || 'email' in b) if (!isEmail(b.email)) bad('Enter a valid email address.');
  if (!partial || 'name' in b) text(b.name, 'The name', 100);
  if (!partial || 'role' in b) if (!ADMIN_ROLES.includes(String(b.role))) bad(`The role must be one of: ${ADMIN_ROLES.join(', ')}.`);
}

const TICKET_PRIORITY = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
export function validateTicketInput(b: { subject?: unknown; body?: unknown; priority?: unknown }): void {
  text(b.subject, 'The subject', 200);
  text(b.body, 'The details', 5000);
  if (b.priority !== undefined && b.priority !== null && !TICKET_PRIORITY.includes(String(b.priority))) bad(`The priority must be one of: ${TICKET_PRIORITY.join(', ')}.`);
}

const AUDIENCES = ['ALL', 'PLAN', 'ORG'];
const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'];
export function validateAnnouncementInput(b: Record<string, unknown>, creating: boolean): void {
  if (creating || 'title' in b) text(b.title, 'The title', 200);
  if (creating || 'body' in b) text(b.body, 'The message', 5000);
  if ('audience' in b && !AUDIENCES.includes(String(b.audience))) bad(`The audience must be one of: ${AUDIENCES.join(', ')}.`);
  if ('severity' in b && !SEVERITIES.includes(String(b.severity))) bad(`The severity must be one of: ${SEVERITIES.join(', ')}.`);
  const aud = String(b.audience ?? 'ALL');
  if ((aud === 'PLAN' || aud === 'ORG') && ('audience' in b || 'audienceRef' in b) && !String(b.audienceRef ?? '').trim()) bad(aud === 'PLAN' ? 'Choose the plan this announcement is for.' : 'Choose the company this announcement is for.');
  const from = b.startsAt ? new Date(String(b.startsAt)) : null;
  const to = b.endsAt ? new Date(String(b.endsAt)) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) bad('An announcement date is not valid.');
  if (from && to && to < from) bad('The announcement cannot end before it starts.');
}

/** Ranges for the numeric platform settings, and the email rule for address settings. */
const SETTING_RANGES: Record<string, [number, number]> = {
  'billing.auto_suspend_days': [0, 365],
  'billing.gst_rate': [0, 100],
  'billing.invoice_due_days': [0, 365],
  'billing.reminder_days': [0, 365],
  'platform.default_trial_days': [0, 365],
};
export function validateSettingValue(key: string, type: string, value: unknown): void {
  if (type === 'number') {
    const range = SETTING_RANGES[key] ?? [0, 1_000_000];
    if (typeof value === 'number' && (value < range[0] || value > range[1])) bad(`This setting must be between ${range[0]} and ${range[1]}.`);
  }
  if (type === 'string' && /(^|\.)email$/.test(key) && typeof value === 'string' && value.trim() !== '' && !isEmail(value)) bad('Enter a valid email address.');
}

export function validateFlagOverrideValue(value: unknown): void {
  if (!['boolean', 'number', 'string'].includes(typeof value)) bad('Send the override as a value: true, false, a number or text.');
}
