import {
  previewDocumentNumber,
  type DocumentNumberingEntry,
} from './document-numbering';

describe('previewDocumentNumber', () => {
  it('formats a never-resetting counter with zero-padding matching the placeholder width', () => {
    const entry: DocumentNumberingEntry = {
      label: 'Employee ID',
      format: 'DP-{0000}',
      resetRule: 'never',
      counter: 4,
      lastPeriodKey: null,
    };
    expect(previewDocumentNumber(entry)).toBe('DP-0005');
  });

  it('resets to 1 for a monthly counter when the period key has rolled over', () => {
    const now = new Date();
    const currentPeriod = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const entry: DocumentNumberingEntry = {
      label: 'Payslip',
      format: 'PS-{YYYYMM}-{0001}',
      resetRule: 'monthly',
      counter: 12,
      lastPeriodKey: '190001', // deliberately stale
    };
    expect(previewDocumentNumber(entry)).toBe(`PS-${currentPeriod}-0001`);
  });

  it('continues incrementing a monthly counter within the same period', () => {
    const now = new Date();
    const currentPeriod = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const entry: DocumentNumberingEntry = {
      label: 'Payslip',
      format: 'PS-{YYYYMM}-{0001}',
      resetRule: 'monthly',
      counter: 3,
      lastPeriodKey: currentPeriod,
    };
    expect(previewDocumentNumber(entry)).toBe(`PS-${currentPeriod}-0004`);
  });

  it('formats a yearly counter', () => {
    const now = new Date();
    const entry: DocumentNumberingEntry = {
      label: 'Offer Letter',
      format: 'OL-{YYYY}-{0001}',
      resetRule: 'yearly',
      counter: 0,
      lastPeriodKey: String(now.getFullYear()),
    };
    expect(previewDocumentNumber(entry)).toBe(`OL-${now.getFullYear()}-0001`);
  });
});
