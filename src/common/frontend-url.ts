// The app has no dedicated FRONTEND_URL env var — CORS_ORIGIN (a
// comma-separated allowlist) already names the frontend's origin, so this
// reuses its first entry rather than introducing a second source of truth
// that could drift from it. Same fallback as main.ts's CORS setup.
export function frontendUrl(): string {
  return (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0];
}
