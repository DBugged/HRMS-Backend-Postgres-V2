// Purpose: The one shared, email-client-safe visual system for every outgoing HRMS email — page shell
//   (branded header, footer, hidden preheader, responsive rules) plus the reusable building blocks
//   (eyebrow, title, info card, status badge, CTA button, notice) the default templates are composed from.
// Responsibilities: Pure string builders only — no DB access, no business logic. Design tokens mirror the
//   frontend (frontend/src/index.css + tailwind.config.js): Plus Jakarta Sans headings / Inter body, primary
//   #5546e0, ink neutrals, 8px buttons, 16px cards, emerald/rose/amber/sky status hues.
// Important: Templates are stored in the DB as {{placeholder}} strings and rendered by renderTemplate(), so the
//   components here can't branch on a variable's value at build time. Two marker conventions are resolved AFTER
//   rendering by finalizeEmailHtml(): <span data-status> (colours the pill from the rendered word) and
//   <!--opt-->…<!--/opt--> (drops an optional row/note whose value rendered empty).
// Important: All layout is tables + inline CSS (Gmail/Outlook/Apple Mail/Yahoo safe). The <style> block only adds
//   progressive enhancement (web-font import, mobile stacking) — the email is fully usable if it's stripped.

export const EMAIL_SHELL_MARKER = '<!--hrms-email-shell-->';

const T = {
  bg: '#f8f9fb',
  card: '#ffffff',
  border: '#dfe3ea',
  divider: '#eef0f4',
  muted: '#eef0f4',
  ink: '#14161d',
  body: '#232733',
  mutedFg: '#586074',
  faint: '#98a1b3',
  primary: '#5546e0',
  primarySoft: '#eef1ff',
  primaryDeep: '#392e9c',
} as const;

// ---------------------------------------------------------------- brand colour

export const DEFAULT_PRIMARY = '#5546e0';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface BrandPalette {
  primary: string;
  primarySoft: string;
  primaryDeep: string;
  // Text colour that stays readable on a `primary` background (button label, header initials).
  onPrimary: string;
}

const DEFAULT_PALETTE: BrandPalette = {
  primary: T.primary,
  primarySoft: T.primarySoft,
  primaryDeep: T.primaryDeep,
  onPrimary: '#ffffff',
};

export function isValidHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v);
}

function rgbOf(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function toHex(rgb: number[]): string {
  return (
    '#' +
    rgb
      .map((c) =>
        Math.max(0, Math.min(255, Math.round(c)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

// WCAG relative luminance (0 = black, 1 = white).
export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Derives the email accent palette from an org's Branding primary colour. Anything that is not a strict
// #RRGGBB (or is the default colour) yields the fixed default palette, so unvalidated strings never reach
// the generated HTML/CSS and default-coloured orgs get byte-identical output.
export function deriveBrandPalette(
  input: string | null | undefined,
): BrandPalette {
  if (!isValidHexColor(input)) return DEFAULT_PALETTE;
  const primary = input.toLowerCase();
  if (primary === DEFAULT_PRIMARY) return DEFAULT_PALETTE;
  const rgb = rgbOf(primary);
  const soft = toHex(rgb.map((c) => c + (255 - c) * 0.92));
  const deep = toHex(rgb.map((c) => c * 0.7));
  // Pick whichever of white / near-black gives the higher contrast ratio.
  const L = relativeLuminance(primary);
  const onPrimary =
    1.05 / (L + 0.05) >= (L + 0.05) / 0.06 ? '#ffffff' : '#14161d';
  return { primary, primarySoft: soft, primaryDeep: deep, onPrimary };
}

// Re-colours already-built email HTML (component output and org-stored templates alike carry the fixed
// default palette as inline literals) with the org's palette. No-op for the default palette.
function applyBrandPalette(html: string, p: BrandPalette): string {
  if (p === DEFAULT_PALETTE) return html;
  return html
    .replace(
      /(background:#5546e0;">\s*<a [^>]*?color:)#ffffff/gi,
      `$1${p.onPrimary}`,
    )
    .replace(/#5546e0/gi, p.primary)
    .replace(/#eef1ff/gi, p.primarySoft)
    .replace(/#392e9c/gi, p.primaryDeep);
}

const FONT_BODY =
  "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_DISPLAY =
  "'Plus Jakarta Sans','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

// Frontend Badge.tsx / ui/alert.tsx status palette (Tailwind emerald/amber/rose/sky 50/700/200).
const TONES: Record<
  Tone,
  { bg: string; fg: string; border: string; dot: string }
> = {
  success: { bg: '#ecfdf5', fg: '#047857', border: '#a7f3d0', dot: '#10b981' },
  warning: { bg: '#fffbeb', fg: '#b45309', border: '#fde68a', dot: '#f59e0b' },
  error: { bg: '#fff1f2', fg: '#be123c', border: '#fecdd3', dot: '#f43f5e' },
  info: { bg: '#f0f9ff', fg: '#0369a1', border: '#bae6fd', dot: '#0ea5e9' },
  neutral: { bg: '#eef0f4', fg: '#586074', border: '#dfe3ea', dot: '#98a1b3' },
};

// Same word->tone mapping the frontend's Badge.tsx uses for these statuses.
const POSITIVE = [
  'approved',
  'processed',
  'active',
  'verified',
  'sanctioned',
  'paid',
  'published',
  'completed',
  'closed',
];
const NEGATIVE = ['rejected', 'absent', 'failed', 'declined'];
const WARNING = ['pending', 'partially approved', 'under review'];

export function statusTone(word: string): Tone {
  const w = word.trim().toLowerCase().replace(/_/g, ' ');
  if (POSITIVE.includes(w)) return w === 'closed' ? 'neutral' : 'success';
  if (NEGATIVE.includes(w)) return 'error';
  if (WARNING.includes(w)) return 'warning';
  if (w === 'cancelled') return 'neutral';
  return 'neutral';
}

// Alias of esc(), exported under a name that reads clearly at call sites that escape user-supplied values.
export const escapeHtml = (value: string | null | undefined): string =>
  esc(value);

export function esc(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- components

export function eyebrow(text: string): string {
  return `<p style="margin:0 0 10px;font-family:${FONT_BODY};font-size:12px;line-height:16px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${T.primary};">${text}</p>`;
}

export function title(text: string): string {
  return `<h1 style="margin:0 0 20px;font-family:${FONT_DISPLAY};font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.01em;color:${T.ink};word-break:break-word;overflow-wrap:anywhere;">${text}</h1>`;
}

export function paragraph(html: string): string {
  return `<p style="margin:0 0 16px;font-family:${FONT_BODY};font-size:15px;line-height:24px;font-weight:400;color:${T.body};word-break:break-word;overflow-wrap:anywhere;">${html}</p>`;
}

export function mutedText(html: string): string {
  return `<p style="margin:0 0 16px;font-family:${FONT_BODY};font-size:13px;line-height:20px;color:${T.mutedFg};word-break:break-word;overflow-wrap:anywhere;">${html}</p>`;
}

// A pill matching the frontend Badge. Written as <span data-status> and coloured by finalizeEmailHtml()
// from whatever word the variable rendered to; the inline style is the neutral fallback (e.g. the Email
// Templates screen's live preview, which doesn't run finalizeEmailHtml).
export function statusBadge(valueHtml: string): string {
  return `<span data-status style="font-family:${FONT_BODY};font-size:12px;font-weight:600;color:${TONES.neutral.fg};">${valueHtml}</span>`;
}

export function optional(valueHtml: string, blockHtml: string): string {
  return `<!--opt--><span data-opt style="display:none;">${valueHtml}</span>${blockHtml}<!--/opt-->`;
}

export interface CardRow {
  label: string;
  // Raw HTML — either plain text/{{placeholder}}s or statusBadge()/link markup.
  value: string;
  optionalValue?: string; // placeholder text that decides whether this row is shown
}

// `dividers: false` drops the hairlines between rows — use it when rows can be individually hidden
// (optionalValue), since a divider belonging to a hidden row would otherwise be left dangling.
export function infoCard(
  rows: CardRow[],
  opts: { dividers?: boolean } = {},
): string {
  const dividers = opts.dividers !== false;
  const body = rows
    .map((row, i) => {
      const last = i === rows.length - 1;
      const cell =
        `<tr><td class="stack lbl" width="38%" valign="top" style="padding:12px 20px;font-family:${FONT_BODY};font-size:12px;line-height:20px;font-weight:500;color:${T.mutedFg};">${row.label}</td>` +
        `<td class="stack val" valign="top" style="padding:12px 20px;font-family:${FONT_BODY};font-size:14px;line-height:20px;font-weight:600;color:${T.ink};word-break:break-word;overflow-wrap:anywhere;">${row.value}</td></tr>` +
        (last || !dividers
          ? ''
          : `<tr><td colspan="2" style="padding:0 20px;"><div style="height:1px;line-height:1px;font-size:1px;background:${T.divider};">&nbsp;</div></td></tr>`);
      return row.optionalValue !== undefined
        ? optional(row.optionalValue, cell)
        : cell;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;background:${T.bg};border:1px solid ${T.border};border-radius:12px;border-collapse:separate;">${body}</table>`;
}

export function button(href: string, label: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn-wrap" style="margin:4px 0 20px;"><tr>` +
    `<td align="center" bgcolor="${T.primary}" style="border-radius:8px;background:${T.primary};">` +
    `<a href="${href}" target="_blank" class="btn" style="display:inline-block;padding:12px 24px;font-family:${FONT_BODY};font-size:14px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>` +
    `</td></tr></table>`
  );
}

export function notice(html: string, tone: Tone = 'info'): string {
  const t = TONES[tone];
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;background:${t.bg};border:1px solid ${t.border};border-radius:12px;border-collapse:separate;"><tr>` +
    `<td style="padding:12px 16px;font-family:${FONT_BODY};font-size:13px;line-height:20px;color:${t.fg};word-break:break-word;overflow-wrap:anywhere;">${html}</td></tr></table>`
  );
}

// A comment/reason block: label + free text, hidden entirely when the value renders empty.
export function optionalNote(label: string, placeholder: string): string {
  return optional(
    placeholder,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr>` +
      `<td style="border-left:3px solid ${T.border};padding:2px 0 2px 14px;font-family:${FONT_BODY};">` +
      `<p style="margin:0 0 2px;font-size:12px;line-height:16px;font-weight:600;color:${T.mutedFg};">${label}</p>` +
      `<p style="margin:0;font-size:14px;line-height:22px;color:${T.body};word-break:break-word;overflow-wrap:anywhere;">${placeholder}</p></td></tr></table>`,
  );
}

export function orderedSteps(items: string[]): string {
  const rows = items
    .map(
      (item, i) =>
        `<tr><td valign="top" width="32" style="padding:0 0 12px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${T.primarySoft}" width="24" height="24" style="width:24px;height:24px;border-radius:12px;background:${T.primarySoft};font-family:${FONT_BODY};font-size:12px;line-height:24px;font-weight:700;color:${T.primaryDeep};">${i + 1}</td></tr></table></td>` +
        `<td valign="top" style="padding:2px 0 12px;font-family:${FONT_BODY};font-size:14px;line-height:22px;color:${T.body};">${item}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">${rows}</table>`;
}

export function checkList(items: string[]): string {
  const rows = items
    .map(
      (item) =>
        `<tr><td valign="top" width="24" style="padding:0 0 8px;font-family:${FONT_BODY};font-size:14px;line-height:22px;font-weight:700;color:${TONES.success.dot};">&#10003;</td>` +
        `<td valign="top" style="padding:0 0 8px;font-family:${FONT_BODY};font-size:14px;line-height:22px;color:${T.body};">${item}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${rows}</table>`;
}

// Composes the standard section order (eyebrow -> title -> greeting/message -> card -> CTA -> notice -> closing);
// callers pass only the sections that apply.
export function emailBody(parts: {
  category: string;
  title: string;
  blocks: string[];
}): string {
  return eyebrow(parts.category) + title(parts.title) + parts.blocks.join('');
}

// ---------------------------------------------------------------- shell

export interface EmailBranding {
  companyName?: string | null;
  phone?: string | null;
  website?: string | null;
  contactEmail?: string | null;
  registeredAddress?: string | null;
  // Ready-made <img> tag from companyLogoImgTag(), '' when the org has no Email Logo.
  logoImgTag?: string;
  // Organization.primaryColor; validated strictly as #RRGGBB, default palette otherwise.
  primaryColor?: string | null;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'HR';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function headerHtml(b: EmailBranding, pal: BrandPalette): string {
  const name = (b.companyName ?? '').trim();
  const mark = b.logoImgTag
    ? b.logoImgTag
        .replace('alt=""', `alt="${esc(name)}"`)
        .replace('max-height:48px', 'max-height:36px')
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="36" height="36" bgcolor="${pal.primary}" style="width:36px;height:36px;border-radius:10px;background:${pal.primary};font-family:${FONT_DISPLAY};font-size:14px;line-height:36px;font-weight:700;color:${pal.onPrimary};">${esc(initialsOf(name))}</td></tr></table>`;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td valign="middle" width="48" style="width:48px;min-width:48px;padding-right:12px;">${mark}</td>` +
    (name
      ? `<td valign="middle" style="font-family:${FONT_DISPLAY};font-size:17px;line-height:24px;font-weight:700;letter-spacing:-0.01em;color:${T.ink};">${esc(name)}</td>`
      : '') +
    `</tr></table>`
  );
}

function footerHtml(b: EmailBranding): string {
  const name = (b.companyName ?? '').trim();
  const contact = [b.registeredAddress, b.phone, b.contactEmail, b.website]
    .map((v) => (v ?? '').trim())
    .filter(Boolean)
    .map(esc);
  return (
    (name
      ? `<p style="margin:0 0 6px;font-family:${FONT_BODY};font-size:12px;line-height:18px;font-weight:600;color:${T.mutedFg};">${esc(name)}</p>`
      : '') +
    (contact.length
      ? `<p style="margin:0 0 10px;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${T.faint};word-break:break-word;overflow-wrap:anywhere;">${contact.join(' &nbsp;&middot;&nbsp; ')}</p>`
      : '') +
    `<p style="margin:0 0 4px;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${T.faint};">This is an automated message${name ? ` from ${esc(name)} HRMS` : ''}. Please do not reply to this email.</p>` +
    (name
      ? `<p style="margin:0;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${T.faint};">&copy; ${new Date().getFullYear()} ${esc(name)}</p>`
      : '')
  );
}

// Wraps already-rendered body HTML in the full email document. Idempotent — HTML that already carries the
// shell marker is returned unchanged.
export function wrapEmailShell(
  contentHtml: string,
  opts: { preheader?: string; branding: EmailBranding },
): string {
  if (contentHtml.includes(EMAIL_SHELL_MARKER)) return contentHtml;
  const pal = deriveBrandPalette(opts.branding.primaryColor);
  const preheader = (opts.preheader ?? '').replace(/<[^>]+>/g, '').trim();
  // Trailing &zwnj;&nbsp; run stops clients pulling body text into the inbox preview after the preheader.
  const preheaderHtml = preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${T.bg};">${esc(preheader)}${'&zwnj;&nbsp;'.repeat(40)}</div>`
    : '';
  return (
    EMAIL_SHELL_MARKER +
    `<!DOCTYPE html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"/><meta http-equiv="X-UA-Compatible" content="IE=edge"/>` +
    `<meta name="x-apple-disable-message-reformatting"/><meta name="format-detection" content="telephone=no,date=no,address=no,email=no"/>` +
    `<meta name="color-scheme" content="light"/><meta name="supported-color-schemes" content="light"/>` +
    `<style type="text/css">` +
    `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap');` +
    `body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}` +
    `table{border-collapse:collapse;}img{border:0;outline:none;text-decoration:none;}a{color:${pal.primary};}` +
    `@media only screen and (max-width:620px){` +
    `.container{width:100%!important;}.px{padding-left:20px!important;padding-right:20px!important;}` +
    `.card-pad{padding:28px 20px!important;}` +
    `.stack{display:block!important;width:100%!important;box-sizing:border-box;}.lbl{padding-bottom:0!important;}.val{padding-top:2px!important;}` +
    `.btn-wrap{width:100%!important;}.btn{display:block!important;padding:14px 20px!important;}}` +
    `</style></head>` +
    `<body style="margin:0;padding:0;background:${T.bg};">` +
    preheaderHtml +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.bg}" style="background:${T.bg};"><tr><td align="center" style="padding:32px 12px;">` +
    `<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">` +
    `<tr><td class="px" style="padding:0 4px 20px;">${headerHtml(opts.branding, pal)}</td></tr>` +
    `<tr><td class="card-pad" style="background:${T.card};border:1px solid ${T.border};border-radius:16px;padding:40px;">${applyBrandPalette(contentHtml, pal)}</td></tr>` +
    `<tr><td class="px" style="padding:24px 4px 0;">${footerHtml(opts.branding)}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

// Resolves the two post-render markers (see file header). Safe to call on any HTML — a no-op when neither
// marker is present (e.g. an org's own custom template).
export function finalizeEmailHtml(html: string): string {
  return html
    .replace(/<!--opt-->([\s\S]*?)<!--\/opt-->/g, (_m, inner: string) => {
      const marked = /<span data-opt[^>]*>([\s\S]*?)<\/span>/.exec(inner);
      const value = marked ? marked[1].replace(/<[^>]+>/g, '').trim() : '';
      return value
        ? inner.replace(/<span data-opt[^>]*>[\s\S]*?<\/span>/, '')
        : '';
    })
    .replace(
      /<span data-status[^>]*>([\s\S]*?)<\/span>/g,
      (_m, text: string) => {
        const plain = text.replace(/<[^>]+>/g, '').trim();
        if (!plain) return '';
        const label = plain.replace(/_/g, ' ').toLowerCase();
        const shown = label.charAt(0).toUpperCase() + label.slice(1);
        const t = TONES[statusTone(plain)];
        return (
          `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${t.bg};border:1px solid ${t.border};font-family:${FONT_BODY};font-size:12px;line-height:16px;font-weight:600;color:${t.fg};white-space:nowrap;">` +
          `<span style="color:${t.dot};">&#9679;</span>&nbsp;${shown}</span>`
        );
      },
    );
}
