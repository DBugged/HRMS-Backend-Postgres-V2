import { rupeesInWords } from './rupees-in-words';

describe('rupeesInWords', () => {
  it.each([
    [0, 'Rupees Zero Only'],
    [1, 'Rupees One Only'],
    [19, 'Rupees Nineteen Only'],
    [100, 'Rupees One Hundred Only'],
    [1250.5, 'Rupees One Thousand Two Hundred Fifty and Fifty Paise Only'],
    [99999, 'Rupees Ninety Nine Thousand Nine Hundred Ninety Nine Only'],
    [100000, 'Rupees One Lakh Only'],
    [2549000, 'Rupees Twenty Five Lakh Forty Nine Thousand Only'],
    [12500000, 'Rupees One Crore Twenty Five Lakh Only'],
    [0.75, 'Rupees Zero and Seventy Five Paise Only'],
  ])('%s', (n, words) => expect(rupeesInWords(n)).toBe(words));
});
