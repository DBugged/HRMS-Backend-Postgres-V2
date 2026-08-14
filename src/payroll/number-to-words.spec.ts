import { amountInWords, numberToIndianWords } from './number-to-words';

describe('numberToIndianWords', () => {
  it('returns "Zero" for 0', () => {
    expect(numberToIndianWords(0)).toBe('Zero');
  });

  it('renders a plain hundreds value', () => {
    expect(numberToIndianWords(456)).toBe('Four Hundred Fifty Six');
  });

  it('renders thousand + hundred groups', () => {
    expect(numberToIndianWords(45600)).toBe('Forty Five Thousand Six Hundred');
  });

  it('renders lakh + thousand + hundred groups', () => {
    expect(numberToIndianWords(1234567)).toBe(
      'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven',
    );
  });

  it('renders crore groups', () => {
    expect(numberToIndianWords(100000000)).toBe('Ten Crore');
  });

  it('rounds and takes the absolute value', () => {
    expect(numberToIndianWords(-99.6)).toBe('One Hundred');
  });
});

describe('amountInWords', () => {
  it('defaults the currency to Rupees and appends "Only"', () => {
    expect(amountInWords(45600)).toBe(
      'Rupees Forty Five Thousand Six Hundred Only',
    );
  });

  it('accepts a custom currency label', () => {
    expect(amountInWords(100, 'Dollars')).toBe('Dollars One Hundred Only');
  });
});
