import { cleanNoticeText } from './privacy-text';

describe('cleanNoticeText', () => {
  it('removes a script block with its contents', () => {
    expect(cleanNoticeText('Hello <script>alert(1)</script> world')).toBe(
      'Hello  world',
    );
  });

  it('removes a script that arrives entity-encoded', () => {
    const out = cleanNoticeText('Hi &lt;script&gt;alert(1)&lt;/script&gt; there');
    expect(out).not.toMatch(/<\s*script/i);
    expect(out).not.toContain('alert(1)');
  });

  it('drops other tags and their event handlers', () => {
    expect(cleanNoticeText('x <img src=x onerror=alert(1)> y')).toBe('x  y');
    expect(cleanNoticeText('<a href="javascript:alert(1)">click</a>')).toBe(
      'click',
    );
  });

  it('keeps ordinary punctuation readable', () => {
    expect(cleanNoticeText('Terms & Conditions < 5 years')).toBe(
      'Terms & Conditions < 5 years',
    );
  });

  it('leaves plain text unchanged', () => {
    expect(cleanNoticeText('We keep your data for 3 years.')).toBe(
      'We keep your data for 3 years.',
    );
  });
});
