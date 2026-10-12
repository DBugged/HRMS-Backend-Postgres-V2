// Purpose: Keeps markup out of the free text the Data Privacy screens store (the privacy notice).
// The notice is shown as plain text, so nothing in it should ever be HTML: a pasted <script> block is removed with its
// contents, any other tag is dropped, and entities are turned back into the characters they stand for, so "Terms &
// Conditions" stays readable and "<script>alert(1)</script>" never reaches an employee's screen.
import sanitizeHtml from 'sanitize-html';

const PLAIN_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
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

export function cleanNoticeText(text: string): string {
  return sanitizeHtml(text, PLAIN_OPTIONS)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
