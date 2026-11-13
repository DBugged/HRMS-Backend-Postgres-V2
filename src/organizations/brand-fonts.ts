// Purpose: The fonts a company may pick for its app (Organization > Branding): one for headings, one for body text.
// Important: every font here was checked to contain the rupee sign, the other currency signs and the punctuation we print,
//   and (except the serif) fixed-width digits for IDs and amounts. Keep this list in sync with the web
//   (frontend/src/utils/brandFonts.ts) and the mobile app (mobile/src/utils/brandFonts.ts).
export const DEFAULT_HEADING_FONT = 'Merriweather';
export const DEFAULT_BODY_FONT = 'Roboto';

/** Fonts allowed for body text. */
export const BODY_FONTS = ['Inter', 'Roboto', 'Public Sans', 'Work Sans', 'Figtree', 'Plus Jakarta Sans'] as const;
/** Fonts allowed for headings: the body fonts plus one serif. */
export const HEADING_FONTS = [...BODY_FONTS, 'Merriweather'] as const;

export function isBodyFont(v: unknown): boolean {
  return typeof v === 'string' && (BODY_FONTS as readonly string[]).includes(v);
}
export function isHeadingFont(v: unknown): boolean {
  return typeof v === 'string' && (HEADING_FONTS as readonly string[]).includes(v);
}
