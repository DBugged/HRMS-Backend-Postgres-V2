/**
 * Pure port of the old backend's numberToWords.js — Indian numbering
 * system (crore/lakh/thousand/hundred groups, not western thousand-groups).
 */

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`;
}

function threeDigits(n: number): string {
  if (n < 100) return twoDigits(n);
  return `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + twoDigits(n % 100) : ''}`;
}

export function numberToIndianWords(num: number): string {
  const n = Math.round(Math.abs(num));
  if (n === 0) return 'Zero';

  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const hundred = n % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (hundred) parts.push(threeDigits(hundred));

  return parts.join(' ');
}

// e.g. "Rupees Forty Five Thousand Six Hundred Only". numberToIndianWords()
// deliberately renders the magnitude only (see its own "rounds and takes
// the absolute value" test) — it's a pure digit-to-words formatter, not
// currency-aware. A negative amount is a real, expected case here though:
// a full & final settlement's netSettlementAmount can go negative when
// recoveries/loan balance exceed what's owed (see SettlementsService),
// and silently dropping the sign would tell an employee they're owed
// money they in fact owe the company. So the sign is handled at this
// level, not pushed down into the pure formatter.
export function amountInWords(amount: number, currency = 'Rupees'): string {
  const rounded = Math.round(amount);
  const prefix = rounded < 0 ? 'Minus ' : '';
  return `${prefix}${currency} ${numberToIndianWords(rounded)} Only`;
}
