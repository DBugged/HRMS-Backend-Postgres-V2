import { readEscalationDays } from './approval-escalation.service';
import { eventLetterMode } from '../letters/auto-letter';

describe('readEscalationDays', () => {
  it('reads whole days per request type, where 0 means never, and ignores anything else', () => {
    expect(readEscalationDays({ escalationDays: { LEAVE: 2, OVERTIME: 0, LOAN: -1, WFH: 1.5, COMP_OFF: '3' } })).toEqual({ LEAVE: 2, OVERTIME: 0 });
    expect(readEscalationDays(null)).toEqual({});
    expect(readEscalationDays({ escalationDays: 'x' })).toEqual({});
  });
});

describe('eventLetterMode', () => {
  it('is review unless the company chose send or off', () => {
    expect(eventLetterMode({}, 'promotionLetter')).toBe('review');
    expect(eventLetterMode({ eventLetters: { promotionLetter: 'send', incrementLetter: 'off' } }, 'promotionLetter')).toBe('send');
    expect(eventLetterMode({ eventLetters: { promotionLetter: 'send', incrementLetter: 'off' } }, 'incrementLetter')).toBe('off');
    expect(eventLetterMode({ eventLetters: { transferLetter: 'bogus' } }, 'transferLetter')).toBe('review');
  });
});
