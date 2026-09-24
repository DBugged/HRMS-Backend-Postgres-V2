// Purpose: Server-side sanitizer for admin-authored Email Template bodies and email signatures.
//   More permissive than letter-templates/rich-text-sanitizer.ts because email layout legitimately
//   needs inline styles, tables and images — but it unconditionally removes anything executable.
// Responsibilities: Parses with sanitize-html (a real HTML parser — htmlparser2) against an explicit
//   allowlist of formatting/layout tags and attributes. Everything else is dropped: <script>/<style> and
//   the raw-text/RCDATA elements (textarea, title, noembed, noframes, xmp, plaintext, noscript, iframe...)
//   are removed together with their contents, every on* event-handler attribute is dropped (none are in
//   the allowlist), URL attributes only accept http(s)/mailto/tel or relative URLs (no javascript:/data:/
//   vbscript:), and dangerous CSS (expression(), javascript:, behavior, -moz-binding) drops the style.
// Important: This replaced a regex tokenizer that kept '<'/'>' inside quoted attribute values verbatim,
//   so `<textarea><img title="</textarea><img src=x onerror=...>">` survived and re-parsed as a live
//   <img onerror> in the browser (mutation XSS). sanitize-html re-serializes from the parse tree and
//   entity-escapes every attribute value and text node, so nothing can re-open a tag. {{variable}}
//   placeholders survive (braces are never escaped), including inside href/src.
import sanitizeHtml from 'sanitize-html';

// Formatting, layout (email-shell tables) and media tags an email body or
// signature legitimately uses. Deliberately excludes every raw-text/RCDATA
// element and anything that can execute, load a document, or submit data.
const ALLOWED_TAGS = [
  'a',
  'abbr',
  'address',
  'b',
  'big',
  'blockquote',
  'br',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

// Presentational attributes any allowed tag may carry. No on* handlers.
const GLOBAL_ATTRS = [
  'style',
  'class',
  'id',
  'title',
  'dir',
  'lang',
  'role',
  'align',
  'valign',
  'width',
  'height',
  'bgcolor',
  'border',
  'cellpadding',
  'cellspacing',
  'colspan',
  'rowspan',
  'color',
  'face',
  'size',
  'aria-*',
];

// Contents of these are dropped along with the tag (not kept as text).
const NON_TEXT_TAGS = [
  'script',
  'style',
  'textarea',
  'option',
  'select',
  'title',
  'noembed',
  'noframes',
  'noscript',
  'xmp',
  'plaintext',
  'iframe',
  'template',
  'object',
  'svg',
  'math',
];

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16) || 0),
    )
    .replace(/&#(\d+);?/g, (_, d: string) =>
      String.fromCodePoint(parseInt(d, 10) || 0),
    )
    .replace(/&colon;/gi, ':');
}

function isDangerousStyle(value: string): boolean {
  const normalized = decodeEntities(value).replace(/\s|\\/g, '');
  return /expression\(|javascript:|vbscript:|behavior:|-moz-binding/i.test(
    normalized,
  );
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    '*': GLOBAL_ATTRS,
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: {},
  allowProtocolRelative: true,
  disallowedTagsMode: 'discard',
  nonTextTags: NON_TEXT_TAGS,
  // Keeps the stored style text as written (no postcss re-serialization);
  // dangerous CSS is removed by the transform below instead.
  parseStyleAttributes: false,
  transformTags: {
    '*': (tagName, attribs) => {
      if (attribs.style !== undefined && isDangerousStyle(attribs.style)) {
        const rest = { ...attribs };
        delete rest.style;
        return { tagName, attribs: rest };
      }
      return { tagName, attribs };
    },
  },
};

export function sanitizeEmailHtml(html: string): string;
export function sanitizeEmailHtml(
  html: string | null | undefined,
): string | null | undefined;
export function sanitizeEmailHtml(
  html: string | null | undefined,
): string | null | undefined {
  if (!html) return html;
  return sanitizeHtml(html, OPTIONS);
}
