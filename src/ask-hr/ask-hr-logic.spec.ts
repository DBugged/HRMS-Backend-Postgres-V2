import { detectIntents, searchPolicies, splitIntoSections, tokenize } from './ask-hr-logic';

describe('ask-hr-logic', () => {
  it('drops filler words and trims plurals', () => {
    expect(tokenize('What is the notice periods?')).toEqual(['notice', 'period']);
  });

  it('detects the personal-data lookups', () => {
    expect(detectIntents('How many casual leaves are left?')).toContain('balance');
    expect(detectIntents('Is Diwali a holiday')).toContain('holiday');
    expect(detectIntents('show my offer letter')).toContain('letters');
    expect(detectIntents('who is on leave today')).toContain('onLeave');
    expect(detectIntents('what was my net pay last month')).toContain('payroll');
    expect(detectIntents('what is the dress code')).toEqual([]);
  });

  it('splits on numbered headings and finds the right section', () => {
    const text = '1. Notice Period\nEmployees must serve 60 days notice before leaving the company.\n2. Dress Code\nBusiness casual is expected Monday to Thursday.';
    expect(splitIntoSections(text)).toHaveLength(2);
    const hits = searchPolicies('what is the notice period', [{ id: 'p1', title: 'HR Policy', contentText: text }]);
    expect(hits[0].heading).toBe('1. Notice Period');
    expect(hits[0].snippet).toContain('60 days');
  });

  it('returns nothing when no policy mentions the words', () => {
    expect(searchPolicies('maternity benefits', [{ id: 'p1', title: 'HR', contentText: '1. Dress Code\nCasual.' }])).toEqual([]);
    expect(searchPolicies('anything', [{ id: 'p1', title: 'HR', contentText: null }])).toEqual([]);
  });
});
