import { describeWait } from './all-exceptions.filter';

describe('describeWait', () => {
  it('says seconds under a minute', () => {
    expect(describeWait(1)).toBe('1 second');
    expect(describeWait(45)).toBe('45 seconds');
    expect(describeWait(59.2)).toBe('1 minute');
  });
  it('rounds up to whole minutes from a minute on', () => {
    expect(describeWait(60)).toBe('1 minute');
    expect(describeWait(61)).toBe('2 minutes');
    expect(describeWait(600)).toBe('10 minutes');
  });
  it('never says zero', () => {
    expect(describeWait(0)).toBe('1 second');
  });
});
