import { summarizeDocumentReview } from './document-review';

describe('summarizeDocumentReview', () => {
  it('counts pending and rejected documents per employee and ignores approved ones', () => {
    const m = summarizeDocumentReview([
      { employeeId: 'a', status: 'PENDING' },
      { employeeId: 'a', status: 'PENDING' },
      { employeeId: 'a', status: 'APPROVED' },
      { employeeId: 'b', status: 'REJECTED' },
    ]);
    expect(m.get('a')).toEqual({ pending: 2, rejected: 0 });
    expect(m.get('b')).toEqual({ pending: 0, rejected: 1 });
    expect(m.has('c')).toBe(false);
  });

  it('is empty when nothing is waiting', () => {
    expect(summarizeDocumentReview([{ employeeId: 'a', status: 'APPROVED' }]).size).toBe(0);
  });
});
