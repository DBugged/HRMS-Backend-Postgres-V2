// Purpose: the Content-Security-Policy that lets the web app's own origins frame a served file (a PDF thumbnail or
//   preview), and nobody else.
// Important: a CSP frame-ancestors directive takes precedence over X-Frame-Options in every current browser, so a
//   proxy or hosting layer in front of the API that adds X-Frame-Options: SAMEORIGIN to everything no longer blocks
//   the app's PDF previews - which is why images showed while PDFs did not.
import { corsOrigins } from '../common/production-config';

export function frameAncestorsPolicy(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const origins = corsOrigins(env).filter((o) => /^https?:\/\//i.test(o));
  return `frame-ancestors 'self' ${origins.join(' ')}`.trim();
}
