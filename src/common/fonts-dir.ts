// Purpose: One place that finds backend-v2/assets/fonts for every PDF generator (payslips, letters, watermark).
// Important: assets/ lives outside src/, so the Nest build does not copy it into dist/. __dirname's usual "two levels
//   up" from a compiled dist/src/<module>/*.js file lands on dist/assets/fonts, which does not exist, so the folder is
//   looked up against a few real candidate roots instead of assuming one fixed depth. This works the same compiled
//   (dist/src/<module>) and under ts-node (src/<module>).
import * as fs from 'fs';
import * as path from 'path';

function resolveFontsDir(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'fonts'),
    path.join(__dirname, '..', '..', '..', 'assets', 'fonts'),
    path.join(process.cwd(), 'assets', 'fonts'),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
}

export const FONTS_DIR = resolveFontsDir();

// Roboto (full, SIL OFL 1.1 — assets/fonts/LICENSE-Roboto-OFL.txt) is the bundled font that has the ₹ (U+20B9) glyph.
// PDFKit's built-in fonts are WinAnsi only (no ₹), and the other bundled families (Merriweather subset, Roboto Mono)
// have no ₹ either, so anything that prints a rupee amount registers and uses these.
export const ROBOTO_FILES = {
  regular: 'Roboto-Regular.ttf',
  bold: 'Roboto-Bold.ttf',
  italic: 'Roboto-Italic.ttf',
} as const;
