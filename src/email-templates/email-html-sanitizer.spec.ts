import { sanitizeEmailHtml } from './email-html-sanitizer';

describe('sanitizeEmailHtml', () => {
  it('strips script/style blocks, event handlers and dangerous URLs', () => {
    const out = sanitizeEmailHtml(
      '<p>a</p><script>alert(1)</script><style>b{}</style>' +
        '<img src="https://x/y.png" onerror="alert(1)" alt="a">' +
        '<a href="jav&#x61;script:alert(1)">x</a>' +
        '<img src="data:image/png;base64,AA"><iframe src="x"></iframe>',
    );
    expect(out).not.toMatch(/script|style|onerror|alert|data:|iframe/i);
    expect(out).toContain('<img src="https://x/y.png" alt="a">');
    expect(out).toContain('<a>x</a>');
  });

  it('keeps inline styles, tables, relative images and placeholders', () => {
    const html =
      '<table border="0"><tr><td style="color:red;padding:4px">Hi {{name}}</td></tr></table>' +
      '<img src="/files/logo.png" /><a href="{{link}}">go</a><br>';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it('escapes a stray unterminated tag opener', () => {
    expect(sanitizeEmailHtml('<img src="x onerror=alert(1)>')).toBe(
      '&lt;img src="x onerror=alert(1)>',
    );
  });
});
