// Purpose: Strips a Letter Template body down to the minimal formatting set the rich-text editor
//   (frontend LetterTemplates.tsx) offers — bold/italic/underline plus bullet/numbered lists — before it's
//   stored. Same allowlist spirit as email-layout.ts's escapeHtml (never trust markup a browser sent us),
//   but here a fixed, small set of tags is deliberately let through rather than the whole string escaped,
//   since bodyText is the one field in the app meant to hold real (if very limited) HTML.
// Responsibilities: Parses with sanitize-html (htmlparser2) — an allowed tag survives with all attributes
//   stripped (no style=, no onclick=, no href="javascript:..."), any other tag is dropped but its inner
//   text kept, and <script>/<style>/raw-text elements (textarea, title, noembed, xmp, ...) are removed
//   together with their contents. Comments are dropped.
// Important: This replaced a regex tag walker (same approach as the old email sanitizer, which was
//   vulnerable to mutation XSS via '<'/'>' left raw in the output). Text is now re-serialized from the
//   parse tree, so '&', '<' and '>' in text come back entity-encoded ('&amp;', '&lt;', '&gt;');
//   letters/rich-text-blocks.ts decodes entities on both its rich and legacy plain-text paths so the PDF
//   still prints the original characters. Newlines and {{placeholders}} pass through untouched, so a
//   legacy plain-text template (one paragraph per line) keeps its paragraph structure. Void tags are
//   serialized as `<br />`.
import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
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
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {},
  disallowedTagsMode: 'discard',
  nonTextTags: [
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
  ],
};

export function sanitizeRichText(html: string | null | undefined): string {
  if (!html) return html ?? '';
  return sanitizeHtml(html, OPTIONS);
}
