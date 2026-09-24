import { sanitizeRichText } from './rich-text-sanitizer';

describe('sanitizeRichText', () => {
  it('preserves bold, italic, underline, and list markup', () => {
    const input =
      '<p>Dear <b>Jane</b>, this is <i>important</i> and <u>underlined</u>.</p>' +
      '<ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>';
    expect(sanitizeRichText(input)).toBe(input);
  });

  it('normalizes tag-equivalent aliases (strong/em) without dropping them', () => {
    const input = '<p><strong>Bold</strong> and <em>emphasis</em></p>';
    expect(sanitizeRichText(input)).toBe(input);
  });

  it('strips <script> tags and their content entirely', () => {
    const input = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
    const out = sanitizeRichText(input);
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
    expect(out).toBe('<p>Hello</p><p>World</p>');
  });

  it('strips <style> tags and their content entirely', () => {
    const input = '<style>body{color:red}</style><p>Hi</p>';
    const out = sanitizeRichText(input);
    expect(out).not.toContain('style');
    expect(out).not.toContain('color:red');
    expect(out).toBe('<p>Hi</p>');
  });

  it('drops onclick/onerror handlers and style attributes on allowed tags', () => {
    const input = '<p onclick="alert(1)" style="color:red">Text</p>';
    expect(sanitizeRichText(input)).toBe('<p>Text</p>');
  });

  it('strips img tags entirely', () => {
    const input = '<p>Before</p><img src="x" onerror="alert(1)" /><p>After</p>';
    const out = sanitizeRichText(input);
    expect(out).not.toContain('img');
    expect(out).not.toContain('onerror');
    expect(out).toBe('<p>Before</p><p>After</p>');
  });

  it('drops arbitrary tags but keeps their inner text', () => {
    const input = '<div class="wrapper"><span>Kept text</span></div>';
    expect(sanitizeRichText(input)).toBe('Kept text');
  });

  it('strips a javascript: link but keeps the link text', () => {
    const input = '<a href="javascript:alert(1)">Click me</a>';
    expect(sanitizeRichText(input)).toBe('Click me');
  });

  it('removes HTML comments', () => {
    const input = '<p>Visible</p><!-- secret comment -->';
    expect(sanitizeRichText(input)).toBe('<p>Visible</p>');
  });

  it('round-trips legacy plain-text bodies unchanged', () => {
    const input = 'Dear {{employeeName}},\n\nThis is to certify...\n\nRegards,';
    expect(sanitizeRichText(input)).toBe(input);
  });

  it('handles null/undefined/empty input gracefully', () => {
    expect(sanitizeRichText(null)).toBe('');
    expect(sanitizeRichText(undefined)).toBe('');
    expect(sanitizeRichText('')).toBe('');
  });
});

describe('sanitizeRichText — mutation-XSS payloads', () => {
  const payloads = [
    '<textarea><img title="</textarea><img src=x onerror=alert(2)>"></textarea>',
    '<noembed><img title="</noembed><img src=x onerror=alert(2)>"></noembed>',
    '<title><img title="</title><img src=x onerror=alert(2)>"></title>',
    '<noframes><img title="</noframes><img src=x onerror=alert(2)>"></noframes>',
    '<xmp><img title="</xmp><img src=x onerror=alert(2)>"></xmp>',
    '<svg><style><img title="</style><img src=x onerror=alert(2)>"></style></svg>',
    '<p title="</p><img src=x onerror=alert(2)>">t</p>',
    '<img src=x onerror=alert(2)//',
    '<b onclick="alert(2)">x</b>',
  ];

  it.each(payloads)(
    'leaves no live tag other than the allowlist for %s',
    (p) => {
      const out = sanitizeRichText(p);
      // Every '<' left in the output must open an allowlisted, attribute-free tag.
      for (const m of out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
        expect([
          'b',
          'strong',
          'i',
          'em',
          'u',
          'ul',
          'ol',
          'li',
          'p',
          'br',
        ]).toContain(m[1].toLowerCase());
        expect(m[2].replace(/\s*\/$/, '')).toBe('');
      }
      expect(out).not.toMatch(/<(?!\/?(b|strong|i|em|u|ul|ol|li|p|br)\b)/i);
    },
  );

  it('entity-encodes text so a stray "<" cannot re-open a tag', () => {
    expect(sanitizeRichText('Salary < 5000 & Bonus > 0')).toBe(
      'Salary &lt; 5000 &amp; Bonus &gt; 0',
    );
  });

  it('keeps line breaks in a legacy plain-text body', () => {
    expect(sanitizeRichText('Full & Final,\nRegards')).toBe(
      'Full &amp; Final,\nRegards',
    );
  });
});
