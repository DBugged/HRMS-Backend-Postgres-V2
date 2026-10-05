import * as fs from 'fs';
import * as path from 'path';
import * as fontkit from 'fontkit';
import { FONTS_DIR, ROBOTO_FILES } from './fonts-dir';

describe('bundled PDF fonts', () => {
  it('finds the fonts folder', () => {
    expect(fs.existsSync(FONTS_DIR)).toBe(true);
  });

  // The earlier bundled Roboto was a cut-down subset with no ₹, so rupee amounts lost their symbol. Guard against a
  // subset (or a different file) being dropped in again.
  it.each(Object.values(ROBOTO_FILES))(
    '%s has the ₹ (U+20B9) glyph',
    (file) => {
      const font = fontkit.openSync(path.join(FONTS_DIR, file)) as fontkit.Font;
      expect(font.hasGlyphForCodePoint(0x20b9)).toBe(true);
    },
  );
});
