// Purpose: Turns a rendered LetterTemplate body — plain text (legacy: one paragraph per line) or the
//   sanitized rich-text HTML the Letter Templates editor now produces (see
//   letter-templates/rich-text-sanitizer.ts) — into the flat array of paragraph strings LetterPdfService
//   already renders one at a time.
// Responsibilities: Splits at block boundaries (<p>, <li>, <br>) into one array entry per paragraph/list
//   item, turning <ul>/<ol><li> into a bullet/numbered-prefixed entry. Inline <b>/<strong>/<i>/<em>/<u> tags
//   are left in each entry for LetterPdfService's own inline-run parser to interpret.
// Important: Content with none of the block tags below round-trips through the exact pre-existing
//   '\n'-split behavior untouched — every template written before rich text existed (and every
//   LetterOverride, which is still plain text edited from a separate screen) renders identically.
const BLOCK_TAG_PRESENT_RE = /<\s*(p|ul|ol|li|br)\b/i;
const TOKEN_RE = /<(\/?)(\s*)(p|ul|ol|li|br|b|strong|i|em|u)\b([^>]*)>/gi;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

interface ListFrame {
  ordered: boolean;
  count: number;
}

export function splitRichTextIntoParagraphs(body: string): string[] {
  if (!body) return [];

  // Legacy path — unchanged from the pre-rich-text behavior: plain text,
  // one paragraph per line, blank lines ignored.
  if (!BLOCK_TAG_PRESENT_RE.test(body)) {
    return body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const paragraphs: string[] = [];
  const listStack: ListFrame[] = [];
  let current = '';

  const pushParagraph = () => {
    const trimmed = current.trim();
    if (trimmed) paragraphs.push(trimmed);
    current = '';
  };

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(body))) {
    const text = body.slice(lastIndex, match.index);
    if (text) current += decodeEntities(text);
    lastIndex = TOKEN_RE.lastIndex;

    const closing = !!match[1];
    const tag = match[3].toLowerCase();

    switch (tag) {
      case 'p':
      case 'br':
        pushParagraph();
        break;
      case 'li':
        if (closing) {
          pushParagraph();
        } else {
          pushParagraph();
          const frame = listStack[listStack.length - 1];
          if (frame) {
            frame.count += 1;
            current = frame.ordered ? `${frame.count}. ` : '•  ';
          }
        }
        break;
      case 'ul':
        if (closing) listStack.pop();
        else {
          pushParagraph();
          listStack.push({ ordered: false, count: 0 });
        }
        break;
      case 'ol':
        if (closing) listStack.pop();
        else {
          pushParagraph();
          listStack.push({ ordered: true, count: 0 });
        }
        break;
      default:
        // Inline formatting tag (b/strong/i/em/u) — kept verbatim for
        // LetterPdfService's inline-run parser.
        current += match[0];
        break;
    }
  }
  const tail = body.slice(lastIndex);
  if (tail) current += decodeEntities(tail);
  pushParagraph();

  return paragraphs;
}
