// Purpose: Server-side sanitizer for admin-authored Email Template bodies and email signatures.
//   More permissive than letter-templates/rich-text-sanitizer.ts because email layout legitimately
//   needs inline styles, tables and images — but it unconditionally removes anything executable:
//   <script>/<style> (tag and contents), every on* event-handler attribute, and javascript:/data:/
//   vbscript: URLs in URL-bearing attributes (href, src, ...). Other tags/attributes pass through.
// Important: Text content is not re-encoded, so {{variable}} placeholders survive untouched.

// Removed with their contents.
const STRIP_WITH_CONTENT_RE = /<(script|style)\b[\s\S]*?<\/\1\s*>/gi;
// An unterminated <script>/<style> swallows the rest of the document.
const STRIP_UNCLOSED_RE = /<(script|style)\b[\s\S]*$/i;

// Tags dropped outright (markup only; any inner text is kept, then sanitized).
const BLOCKED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'meta',
  'link',
  'form',
  'svg',
  'math',
  'noscript',
  'template',
]);

const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'background',
  'poster',
  'xlink:href',
  'srcset',
  'lowsrc',
  'dynsrc',
  'cite',
  'longdesc',
  'usemap',
]);

// One comment, one tag (quoted attribute values may contain '>'), or a stray '<'.
const TOKEN_RE =
  /<!--[\s\S]*?-->|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|</g;

const ATTR_RE =
  /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const SAFE_ATTR_NAME_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16) || 0),
    )
    .replace(/&#(\d+);?/g, (_, d: string) =>
      String.fromCodePoint(parseInt(d, 10) || 0),
    )
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n');
}

function isDangerousUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const normalized = decodeEntities(value).replace(/[\s\u0000-\u001f]/g, '');
  return /(^|,)(javascript|data|vbscript):/i.test(normalized);
}

function isDangerousStyle(value: string): boolean {
  const normalized = decodeEntities(value).replace(/\s|\\/g, '');
  return /expression\(|javascript:|vbscript:|behavior:|-moz-binding/i.test(
    normalized,
  );
}

function sanitizeAttributes(raw: string): string {
  let out = '';
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!SAFE_ATTR_NAME_RE.test(name)) continue;
    if (name.startsWith('on')) continue; // event handlers
    const hasValue =
      m[2] !== undefined || m[3] !== undefined || m[4] !== undefined;
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (URL_ATTRS.has(name) && isDangerousUrl(value)) continue;
    if (name === 'style' && isDangerousStyle(value)) continue;
    out += hasValue
      ? ` ${name}="${value.replace(/"/g, '&quot;')}"`
      : ` ${name}`;
  }
  return out;
}

export function sanitizeEmailHtml(html: string): string;
export function sanitizeEmailHtml(
  html: string | null | undefined,
): string | null | undefined;
export function sanitizeEmailHtml(
  html: string | null | undefined,
): string | null | undefined {
  if (!html) return html;
  const stripped = html
    .replace(STRIP_WITH_CONTENT_RE, '')
    .replace(STRIP_UNCLOSED_RE, '');
  return stripped.replace(
    TOKEN_RE,
    (match: string, slash?: string, tagName?: string, attrs?: string) => {
      if (match === '<') return '&lt;'; // stray '<' that isn't a well-formed tag
      if (!tagName) return ''; // comment / doctype / processing instruction
      const name = tagName.toLowerCase();
      if (BLOCKED_TAGS.has(name)) return '';
      if (slash) return `</${name}>`;
      const selfClosing = /\/\s*$/.test(attrs ?? '');
      return `<${name}${sanitizeAttributes(attrs ?? '')}${selfClosing ? ' /' : ''}>`;
    },
  );
}
