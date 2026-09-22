// Purpose: Strips a Letter Template body down to the minimal formatting set the rich-text editor
//   (frontend LetterTemplates.tsx) offers — bold/italic/underline plus bullet/numbered lists — before it's
//   stored. Same allowlist spirit as email-layout.ts's escapeHtml (never trust markup a browser sent us),
//   but here a fixed, small set of tags is deliberately let through rather than the whole string escaped,
//   since bodyText is the one field in the app meant to hold real (if very limited) HTML.
// Responsibilities: Removes <script>/<style> blocks (tag *and* contents) outright, then walks every other
//   tag one at a time — an allowed tag survives with all attributes stripped (no style=, no onclick=, no
//   href="javascript:..."), anything else (its own tag markup only — inner text is kept) is dropped.
// Important: No entity decoding/re-encoding happens here — text content passes through byte for byte, so a
//   template saved before rich text existed (plain text, one paragraph per line) round-trips unchanged.
const ALLOWED_TAGS = new Set([
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
]);

// <script>/<style> are removed with their contents — an allowlist walk
// alone would drop the tags but leave the (potentially executable/CSS)
// text between them behind.
const STRIP_WITH_CONTENT_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

// Matches one HTML tag, comment, or CDATA section at a time. Capture group
// 1 is the tag name for a real tag; comments/CDATA have no capture and are
// dropped outright.
const TAG_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;

export function sanitizeRichText(html: string | null | undefined): string {
  if (!html) return html ?? '';
  const withoutScriptsAndStyles = html.replace(STRIP_WITH_CONTENT_RE, '');
  return withoutScriptsAndStyles.replace(
    TAG_RE,
    (match: string, tagName?: string) => {
      if (!tagName) return ''; // comment / doctype / CDATA — drop entirely
      const name = tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return ''; // disallowed tag — keep inner text, drop the tag itself
      const closing = match.startsWith('</');
      return closing ? `</${name}>` : `<${name}>`; // allowed tag — kept, attributes stripped
    },
  );
}
