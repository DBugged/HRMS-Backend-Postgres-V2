// The app has no dedicated FRONTEND_URL env var — CORS_ORIGIN (a
// comma-separated allowlist) already names the frontend's origin, so this
// reuses its first entry rather than introducing a second source of truth
// that could drift from it. Same fallback as main.ts's CORS setup.
// CHANGE HERE (production): set FRONTEND_URL (or CORS_ORIGIN) to the live web app address. Registration, approval, rejection and
// welcome emails, and the Control Panel's System Check, all use it; the localhost fallback is for development only.
export function frontendUrl(): string {
  return (
    process.env.FRONTEND_URL ||
    process.env.CORS_ORIGIN ||
    'http://localhost:5173'
  ).split(',')[0];
}
