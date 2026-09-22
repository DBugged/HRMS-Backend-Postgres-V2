import { splitRichTextIntoParagraphs } from './rich-text-blocks';

describe('splitRichTextIntoParagraphs', () => {
  it('falls back to legacy \\n-split behavior for plain text', () => {
    const body = 'Dear Jane,\n\nThis is to certify...\n\n\nRegards,';
    expect(splitRichTextIntoParagraphs(body)).toEqual([
      'Dear Jane,',
      'This is to certify...',
      'Regards,',
    ]);
  });

  it('splits <p> blocks into separate paragraphs, keeping inline tags', () => {
    const body = '<p>Dear <b>Jane</b>,</p><p>This is <i>important</i>.</p>';
    expect(splitRichTextIntoParagraphs(body)).toEqual([
      'Dear <b>Jane</b>,',
      'This is <i>important</i>.',
    ]);
  });

  it('renders an unordered list as bullet-prefixed entries', () => {
    const body = '<ul><li>One</li><li>Two</li></ul>';
    expect(splitRichTextIntoParagraphs(body)).toEqual(['•  One', '•  Two']);
  });

  it('renders an ordered list as numbered entries', () => {
    const body = '<ol><li>First</li><li>Second</li></ol>';
    expect(splitRichTextIntoParagraphs(body)).toEqual([
      '1. First',
      '2. Second',
    ]);
  });

  it('treats <br> as a paragraph break', () => {
    const body = '<p>Line one<br>Line two</p>';
    expect(splitRichTextIntoParagraphs(body)).toEqual(['Line one', 'Line two']);
  });

  it('decodes basic HTML entities in text content', () => {
    const body = '<p>Terms &amp; Conditions &lt;apply&gt;</p>';
    expect(splitRichTextIntoParagraphs(body)).toEqual([
      'Terms & Conditions <apply>',
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(splitRichTextIntoParagraphs('')).toEqual([]);
  });
});
