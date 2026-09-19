import { maskPersonalData, maskTail } from './personal-data-mask';

describe('personal-data-mask', () => {
  it('keeps only the last 4 characters', () => {
    expect(maskTail('ABCDE1234F')).toBe('******234F');
    expect(maskTail('123')).toBe('***');
  });

  it('masks sensitive keys and leaves the rest untouched', () => {
    const out = maskPersonalData({
      panNumber: 'ABCDE1234F',
      aadhaarNumber: '123412341234',
      uan: '100200300400',
      bankAccountNo: '00112233445566',
      bankIFSC: 'HDFC0001234',
      passportNo: 'N1234567',
      currentAddress: '12 Main St',
      gender: 'F',
    });
    expect(out.panNumber).toBe('******234F');
    expect(out.aadhaarNumber).toBe('********1234');
    expect(out.uan).toBe('********0400');
    expect(out.bankAccountNo).toBe('**********5566');
    expect(out.bankIFSC).toBe('*******1234');
    expect(out.passportNo).toBe('****4567');
    expect(out.currentAddress).toBe('12 Main St');
    expect(out.gender).toBe('F');
  });
});
