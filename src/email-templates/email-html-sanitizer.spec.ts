import { sanitizeEmailHtml } from './email-html-sanitizer';

// Matches a real (unescaped) tag carrying an event handler — i.e. something
// a browser would execute after innerHTML. The sanitizer always emits
// double-quoted attribute values with any `"` inside escaped, so blanking
// out "..." first leaves only live markup to test.
const HANDLER_RE = /<[a-z][^>]*\son[a-z]+\s*=/i;
const hasLiveHandler = (s: string | null | undefined) =>
  HANDLER_RE.test((s ?? '').replace(/"[^"]*"/g, '""'));

describe('sanitizeEmailHtml', () => {
  it('strips script/style blocks, event handlers and dangerous URLs', () => {
    const out = sanitizeEmailHtml(
      '<p>a</p><script>alert(1)</script><style>b{}</style>' +
        '<img src="https://x/y.png" onerror="alert(1)" alt="a">' +
        '<a href="jav&#x61;script:alert(1)">x</a>' +
        '<img src="data:image/png;base64,AA"><iframe src="x"></iframe>',
    );
    expect(out).not.toMatch(/script|style|onerror|alert|data:|iframe/i);
    // sanitize-html serializes void elements as `<img ... />`.
    expect(out).toContain('<img src="https://x/y.png" alt="a" />');
    expect(out).toContain('<a>x</a>');
  });

  it('keeps inline styles, tables, relative images and placeholders', () => {
    const html =
      '<table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%">' +
      '<tr><td style="color:red;padding:4px" align="center" valign="top">Hi {{name}}</td></tr></table>' +
      '<img src="/files/logo.png" alt="logo" width="120" /><a href="{{link}}" target="_blank">go</a><br />' +
      '<p><strong>Bold</strong> <em>it</em> <u>u</u></p><ul><li>one</li></ul>';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it('keeps https/mailto/tel links and drops vbscript/data links', () => {
    expect(
      sanitizeEmailHtml(
        '<a href="https://a.test/x?y=1&amp;z=2">a</a><a href="mailto:x@y.test">m</a><a href="tel:+911">t</a>',
      ),
    ).toBe(
      '<a href="https://a.test/x?y=1&amp;z=2">a</a><a href="mailto:x@y.test">m</a><a href="tel:+911">t</a>',
    );
    expect(sanitizeEmailHtml('<a href="vbscript:msgbox(1)">v</a>')).toBe(
      '<a>v</a>',
    );
    expect(
      sanitizeEmailHtml(
        '<a href="data:text/html,<script>alert(1)</script>">d</a>',
      ),
    ).toBe('<a>d</a>');
  });

  it('drops a style attribute carrying executable CSS', () => {
    expect(
      sanitizeEmailHtml(
        '<div style="width:expression(alert(1))">x</div><div style="background:url(javascript:alert(1))">y</div>',
      ),
    ).toBe('<div>x</div><div>y</div>');
  });

  it('never leaves a live tag from an unterminated tag opener', () => {
    const out = sanitizeEmailHtml('<img src="x onerror=alert(1)>');
    expect(hasLiveHandler(out)).toBe(false);
  });

  describe('mutation-XSS payloads (raw-text / RCDATA elements)', () => {
    const payloads = [
      '<textarea><img title="</textarea><img src=x onerror=alert(2)>"></textarea>',
      '<noembed><img title="</noembed><img src=x onerror=alert(2)>"></noembed>',
      '<title><img title="</title><img src=x onerror=alert(2)>"></title>',
      '<noframes><img title="</noframes><img src=x onerror=alert(2)>"></noframes>',
      '<xmp><img title="</xmp><img src=x onerror=alert(2)>"></xmp>',
      '<noscript><img title="</noscript><img src=x onerror=alert(2)>"></noscript>',
      '<iframe><img title="</iframe><img src=x onerror=alert(2)>"></iframe>',
      '<style><img title="</style><img src=x onerror=alert(2)>"></style>',
      '<svg><style><img title="</style><img src=x onerror=alert(2)>"></style></svg>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(2)>',
      '<plaintext><img src=x onerror=alert(2)>',
      '<p title="</p><img src=x onerror=alert(2)>">t</p>',
      '<img src=x onerror=alert(2)//',
      '<a href="javascript&colon;alert(2)">x</a>',
      '<a href=" &#14;javascript:alert(2)">x</a>',
      '<img src="x" ONERROR="alert(2)">',
      '<div onmouseover="alert(2)">x</div>',
      '<form><button formaction="javascript:alert(2)">x</button></form>',
      '<object data="javascript:alert(2)"></object>',
      '<embed src="javascript:alert(2)">',
      '<base href="javascript:alert(2)//">',
      '<meta http-equiv="refresh" content="0;url=javascript:alert(2)">',
    ];

    it.each(payloads)('neutralizes %s', (payload) => {
      const out = sanitizeEmailHtml(payload);
      expect(hasLiveHandler(out)).toBe(false);
      expect(out).not.toMatch(/javascript:/i);
      expect(out).not.toMatch(
        /<(textarea|title|noembed|noframes|xmp|plaintext|noscript|script|style|iframe|svg|math|object|embed|base|meta|form|button)\b/i,
      );
      // Idempotent: a second pass can't uncover anything new.
      expect(sanitizeEmailHtml(out)).toBe(out);
    });

    it('escapes angle brackets inside attribute values', () => {
      expect(
        sanitizeEmailHtml('<p title="</p><img src=x onerror=alert(2)>">t</p>'),
      ).toBe('<p title="&lt;/p&gt;&lt;img src=x onerror=alert(2)&gt;">t</p>');
    });
  });

  it('passes null/undefined/empty through', () => {
    expect(sanitizeEmailHtml(null)).toBeNull();
    expect(sanitizeEmailHtml(undefined)).toBeUndefined();
    expect(sanitizeEmailHtml('')).toBe('');
  });
});
